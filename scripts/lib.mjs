// lib.mjs — shared utilities for the release scripts.
//
// One registry query implementation, one semver comparison, one JSON/read-write
// helper: gcm/gbump/mono-release/mono-tagcheck previously each carried its own
// copy of these, so a fix had to be applied four times and a single release
// flow queried the npm registry three times.
//
// The registry helpers distinguish three states so callers can keep their
// distinct warnings without re-implementing the fetch:
//   status "ok"          — package exists and has valid X.Y.Z versions
//   status "unknown"     — 404, or exists with no valid versions (never seeded)
//   status "unreachable" — network error / timeout / non-404 HTTP failure

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const REGISTRY_TIMEOUT_MS = 10000;

export function isValidVersion(v) {
	return /^\d+\.\d+\.\d+$/.test(v);
}

export function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`✗ cannot read ${path}: ${err.message}`);
		process.exit(1);
	}
}

export function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// ── workspace 包发现 + 模糊匹配（gcm -p / --list 共用）───────────────────
//
// 包清单来自 packages/*（含 package.json 的目录，按名排序）。-p 的模糊匹配
// 在包名之外还有二级匹配：packages/*/ 下的裸根 .ts 小工具（如 pi-gadget 下的
// pi-cite-wslpath.ts）命中时归到其母包——单文件小工具没有独立版本，发布与
// changelog 都挂在母包上。

// packages/* 中带 package.json 的包名列表（排序，稳定输出）。
export function packageScopes(root) {
	const dir = join(root, "packages");
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter(
				(e) =>
					e.isDirectory() &&
					e.name !== "node_modules" &&
					existsSync(join(dir, e.name, "package.json")),
			)
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

// [{ pkg, version, path }] —— --list 输出 packages@versions 的数据源。
export function packageMembers(root) {
	return packageScopes(root).map((pkg) => {
		const path = join(root, "packages", pkg, "package.json");
		try {
			const version = JSON.parse(readFileSync(path, "utf8")).version;
			return { pkg, version: version ?? "?", path };
		} catch {
			return { pkg, version: "?", path };
		}
	});
}

// "<pkg>@<version>" 行（--list 输出）。
export function packageVersionLines(root) {
	return packageMembers(root).map((m) => `${m.pkg}@${m.version}`);
}

// 二级匹配索引：裸根 .ts 小工具 basename（不带扩展名）→ { pkg, file }。
// 只扫 packages/*/*.ts 一层（子目录里的模块不算“小工具”）。
export function bareRootToolScopes(root) {
	const map = new Map();
	for (const pkg of packageScopes(root)) {
		const dir = join(root, "packages", pkg);
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			const base = entry.name.slice(0, -3);
			if (base.length > 0 && !map.has(base)) {
				map.set(base, { pkg, file: entry.name });
			}
		}
	}
	return map;
}

// 模糊打分 0..1：精确 > 子串 > 前缀 > 子序列命中，否则 0（= 无候选）。
export function fuzzyScore(query, candidate) {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (c === q) return 1;
	if (c.includes(q)) return 0.85;
	if (c.startsWith(q)) return 0.75;
	let i = 0;
	for (const ch of q) {
		const j = c.indexOf(ch, i);
		if (j === -1) return 0;
		i = j + 1;
	}
	return 0.5 + 0.1 * (q.length / c.length);
}

// 模糊候选排行：一级匹配包名（+ 调用方给的跨切面词表），二级匹配裸根 .ts
// 小工具并归到母包。返回 [{ scope, score, via }]，via 为 null（直接命中包名）
// 或 "tool:<文件名>"（二级命中）；同一 scope 只保留最高分命中，按分数降序。
export function fuzzyScopeCandidates(input, { root, crossScopes = [] }) {
	const scopes = packageScopes(root);
	const tools = bareRootToolScopes(root);
	const hits = [];
	for (const s of [...scopes, ...crossScopes]) {
		const score = fuzzyScore(input, s);
		if (score >= 0.5) hits.push({ scope: s, score, via: null });
	}
	for (const [base, { pkg, file }] of tools) {
		const score = Math.max(fuzzyScore(input, base), fuzzyScore(input, file));
		if (score >= 0.5) hits.push({ scope: pkg, score, via: `tool:${file}` });
	}
	const best = new Map();
	for (const h of hits) {
		const prev = best.get(h.scope);
		if (!prev || h.score > prev.score) best.set(h.scope, h);
	}
	return [...best.values()]
		.sort((a, b) => b.score - a.score || a.scope.length - b.scope.length)
		.slice(0, 8);
}

// 交互提问（TTY 二次确认用；非 TTY 调用方不会走到 ask）。
export function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(question, (answer) => {
			rl.close();
			// Ctrl-D (EOF) 时 answer 为 null——原样上抛不 trim，调用方按
			// 非确认处理（单/多候选都落到 fail("已取消")），避免 TypeError。
			res(answer === null ? null : answer.trim());
		});
	});
}

// 候选展示: 直接命中显示包名，二级小工具命中标注来源文件。
function describeScopeCandidate(c) {
	return c.via ? `${c.scope}（via ${c.via.slice(5)}）` : c.scope;
}

function defaultFail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

function defaultWarn(msg) {
	console.warn(`⚠ ${msg}`);
}

// 模糊 scope 解析（gcm -p / gbump -p 共用的一份实现）:
//   精确命中包名或跨切面词表 → 直接返回；
//   否则 fuzzyScopeCandidates 打分后二次确认:
//     TTY: 唯一候选回车确认；多候选回车确认首选 / 输入序号 / 输入完整包名
//     非 TTY: 唯一候选须 yes 接受；多候选必须改用完整包名
//   fail/warn 可注入（调用方保持各自的错误提示风格），默认与 gcm 一致。
//   调用方语义差异只由参数表达: gbump 传 crossScopes=[]（发版只认包），
//   gcm 传 CROSS_SCOPES（提交 scope 含 scripts/ci/docs 等跨切面词）。
export async function resolvePackageScope(
	input,
	{
		root,
		crossScopes = [],
		yes = false,
		fail = defaultFail,
		warn = defaultWarn,
	} = {},
) {
	const exactScopes = [...packageScopes(root), ...crossScopes];
	if (exactScopes.includes(input)) return input; // 精确命中: 包名或跨切面词表

	const scored = fuzzyScopeCandidates(input, { root, crossScopes });

	if (scored.length === 0) {
		const cross =
			crossScopes.length > 0 ? `；跨切面: ${crossScopes.join("/")}` : "";
		fail(
			`scope "${input}" 无候选匹配——包名: ${packageScopes(root).join(", ")}${cross}`,
		);
	}

	const interactive = process.stdin.isTTY && process.stdout.isTTY;
	if (!interactive) {
		if (scored.length === 1) {
			if (!yes) {
				fail(
					`模糊匹配 "${input}" → ${describeScopeCandidate(scored[0])}（二次确认: 追加 -y 接受）`,
				);
			}
			warn(
				`模糊匹配 "${input}" → ${describeScopeCandidate(scored[0])}（-y 已确认）`,
			);
			return scored[0].scope;
		}
		fail(
			`模糊匹配 "${input}" 命中多个候选（${scored.map(describeScopeCandidate).join(" / ")}）——请使用完整包名，或 TTY 下交互选择`,
		);
	}

	if (scored.length === 1) {
		const ans = await ask(
			`模糊匹配 "${input}" → 候选 ${describeScopeCandidate(scored[0])}。回车确认 [Y/n] `,
		);
		if (ans === "" || /^y(es)?$/i.test(ans)) return scored[0].scope;
		fail("已取消");
	}

	console.warn(`⚠ 模糊匹配 "${input}" 命中多个候选（回车确认首选）:`);
	for (const [i, c] of scored.entries()) {
		console.log(`  ${i + 1}) ${describeScopeCandidate(c)}`);
	}
	const ans = await ask(
		"回车确认首选 / 输入序号 / 输入完整包名（其他输入取消）: ",
	);
	if (ans === "") return scored[0].scope; // enter = 确认首选
	if (/^\d+$/.test(ans)) {
		const pick = scored[Number(ans) - 1];
		if (pick) return pick.scope;
		fail(`无效序号: ${ans}`);
	}
	if (exactScopes.includes(ans)) return ans; // 输入完整包名精确指定
	fail("已取消");
}

// Surgical sync of bun.lock's workspace version fields for the given
// { pkg -> version } entries. bun.lock (lockfileVersion 1) records each
// workspace member's version; a release bump must follow it into the lock
// WITHOUT a full `bun install`, which could re-resolve "latest"
// devDependencies and drag unrelated changes into the release commit.
// The edit is exactly the one-line change a plain bun install would make
// (verified: bun install produces zero further diff after this runs).
export function syncLockfileWorkspaceVersions(lockPath, entries) {
	const lines = readFileSync(lockPath, "utf8").split("\n");
	let pending = Object.keys(entries).length;
	for (let i = 0; i < lines.length && pending > 0; i++) {
		const m = lines[i].match(/^\s*"packages\/([a-z0-9-]+)":\s*\{/);
		if (!m || !(m[1] in entries)) continue;
		const versionIdx = lines
			.slice(i + 1, i + 4)
			.findIndex((l) => l.includes('"version"'));
		if (versionIdx === -1) continue;
		lines[i + 1 + versionIdx] = lines[i + 1 + versionIdx].replace(
			/(\s*"version":\s*)"[^"]*"/,
			`$1"${entries[m[1]]}"`,
		);
		pending--;
	}
	if (pending > 0) {
		console.error(
			`✗ bun.lock sync incomplete (${pending} workspace version field(s) not found)`,
		);
		process.exit(1);
	}
	writeFileSync(lockPath, lines.join("\n"));
}

// Raw registry document with reachability info, or null only on hard failure.
async function fetchRegistry(name) {
	try {
		const res = await fetch(
			`https://registry.npmjs.org/${name.replace("/", "%2F")}`,
			{ signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
		);
		if (res.status === 404) return { kind: "unknown" };
		if (!res.ok) return { kind: "unreachable" };
		return { kind: "ok", doc: await res.json() };
	} catch {
		return { kind: "unreachable" };
	}
}

// Highest published X.Y.Z version: { status: "ok"|"unknown"|"unreachable", max }.
export async function registryBaseline(name) {
	const res = await fetchRegistry(name);
	if (res.kind !== "ok") return { status: res.kind, max: null };
	const versions = Object.keys(res.doc.versions ?? {}).filter(isValidVersion);
	if (versions.length === 0) return { status: "unknown", max: null };
	return {
		status: "ok",
		max: versions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b)),
	};
}

// { published, unreachable }: published=false when the registry is unreachable
// too, so callers can warn on unreachable but stay silent on a 404.
export async function isPublished(name, version) {
	const res = await fetchRegistry(name);
	if (res.kind !== "ok")
		return { published: false, unreachable: res.kind === "unreachable" };
	return {
		published: Object.keys(res.doc.versions ?? {}).includes(version),
		unreachable: false,
	};
}

// Read-only git helpers (the release scripts must never git-write via these).
export function runCapture(cmd, cwd) {
	try {
		return execSync(cmd, { cwd, encoding: "utf8" });
	} catch {
		return "";
	}
}

export function gitDirty(cwd) {
	return runCapture("git status --porcelain", cwd).trim();
}
