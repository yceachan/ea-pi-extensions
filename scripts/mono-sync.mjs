#!/usr/bin/env bun
// mono-sync — per-package alignment with the npm registry.
//
// Packages share no version under the per-package model; each one must not
// fall behind its own registry baseline (its highest published version).
// This helper checks, reports, aligns (--sync) or resets (--reset) each
// package's manifest version to that baseline. --sync/--reset also refresh
// the workspace automatically (bun install, so bun.lock matches the aligned
// manifests) and then report the resulting local file changes / dirty-tree
// state. It never performs git WRITE operations (scripts/mono-release.mjs
// owns the commit/tag/push part of a release) — git status is read-only and
// only used for the report.
//
// Advancing versions is release semantics — that belongs to mono-release.
// The two actions that CHANGE versions here:
//   --sync  aligns a package that is BEHIND its registry baseline up to it;
//   --reset rewrites a package that is AHEAD (a failed, unpublished release)
//           back down to its published baseline — the only sanctioned
//           downward move, and the target is always an already-published
//           version, so nothing new can be created by accident.
// --sync refuses to downgrade; --reset refuses while anything is behind.

import { readdirSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareVersions,
	isValidVersion,
	readJson,
	registryBaseline,
	writeJson,
} from "./lib.mjs";

const HELP = `mono-sync — 逐包检查 / 对齐 registry 基线

用法:
  bun run mono-sync                    显示每包本地版本 vs registry 基线
  bun run mono-sync -- --check         门禁（有包低于基线时 exit 1）
  bun run mono-sync -- --sync          落后包对齐基线 + 自动刷新 workspace + 报告变动
  bun run mono-sync -- --reset         失败发布后：领先包复位回基线 + 自动刷新 workspace
  bun run mono-sync -- --sync --dry-run  预览不写入
  bun run mono-sync -- --help          显示本帮助

说明:
  - 覆盖对象: packages/*（根 manifest 无版本，不参与）
  - 逐包独立版本: 基线 = 该包在 registry 的最高已发布版本
  - 本地高于基线 = 发版未完成；--sync 拒绝降级（--check 仅告警）
  - --sync 对落后包: 对齐 manifest 版本 → 自动 bun install 刷新 bun.lock →
    报告本地文件变动与仓库脏状态（只读 git status，不做任何 git 写操作）
  - --reset: 只复位领先包（本地 > 基线）回基线；有落后包时拒绝（先 --sync）——
    目标必是已发布的基线版本，永不产生新版本；与 --sync 互斥
  - 不提供 bump / --set: 推进版本号是 mono-release 的职责
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}

const dryRun = args.includes("--dry-run");
const doCheck = args.includes("--check");
const doSync = args.includes("--sync");
const doReset = args.includes("--reset");

const known = ["--dry-run", "--check", "--sync", "--reset", "--help", "-h"];
const unknown = args.filter((a) => !known.includes(a));
if (unknown.length > 0) {
	console.error(`✗ unknown argument(s): ${unknown.join(", ")}`);
	console.error("  Run mono-sync --help for usage.");
	process.exit(1);
}
if (doSync && doReset) {
	console.error("✗ --sync 与 --reset 互斥——一次只做一个方向（对齐或复位）");
	process.exit(1);
}

async function baselineFor(name) {
	const b = await registryBaseline(name);
	if (b.status === "unreachable") {
		console.error(`✗ cannot reach registry for ${name}`);
		process.exit(1);
	}
	return b.max; // null when the package was never seeded
}

function packageMembers() {
	const members = [];
	const dir = join(root, "packages");
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === "node_modules") continue;
		const path = join(dir, entry.name, "package.json");
		try {
			members.push({ pkg: entry.name, path, json: readJson(path) });
		} catch {}
	}
	return members;
}

const members = packageMembers();
const baselines = new Map();
for (const m of members) {
	baselines.set(m.pkg, await baselineFor(`@yceachan/${m.pkg}`));
}

const rows = members.map((m) => {
	const local = m.json.version;
	const base = baselines.get(m.pkg) ?? "（未发布）";
	let state = "ok";
	if (base !== "（未发布）") {
		const cmp = compareVersions(local, base);
		if (cmp < 0) state = "behind";
		else if (cmp > 0) state = "ahead";
	}
	return { ...m, base, state };
});

console.log("─".repeat(52));
for (const r of rows) {
	console.log(
		`  ${`@yceachan/${r.pkg}`.padEnd(30)} local ${r.json.version.padEnd(8)} base ${r.base}`,
	);
}
console.log("─".repeat(52));

const behind = rows.filter((r) => r.state === "behind");
const ahead = rows.filter((r) => r.state === "ahead");
if (behind.length === 0 && ahead.length === 0) {
	console.log("✓ 所有包已与各自 registry 基线对齐");
} else {
	if (behind.length > 0) {
		console.log(`✗ 落后基线: ${behind.map((r) => r.pkg).join(", ")}`);
		if (!doSync) {
			console.log("  → bun run mono-sync -- --sync 对齐并自动刷新 workspace");
		}
	}
	if (ahead.length > 0)
		console.warn(
			`⚠ 领先基线（发版未完成?）: ${ahead.map((r) => r.pkg).join(", ")}`,
		);
}

if (doCheck) {
	process.exit(behind.length > 0 ? 1 : 0);
}

if (doSync) {
	if (ahead.length > 0) {
		console.error(
			`✗ ${ahead.map((r) => r.pkg).join(", ")} 本地领先 registry 基线——`,
		);
		console.error(
			"  领先通常意味着上一次发布未完成；请先按容灾手册处理失败的发布，再考虑对齐",
		);
		process.exit(1);
	}
	if (behind.length === 0) {
		console.log("✓ 无包落后基线，无需对齐");
		process.exit(0);
	}
	for (const r of behind) {
		console.log(
			`${dryRun ? "[dry-run] " : ""}${r.pkg}: ${r.json.version} → ${r.base}`,
		);
		if (!dryRun) {
			r.json.version = r.base;
			writeJson(r.path, r.json);
		}
	}
	if (dryRun) {
		console.log(
			"[dry-run] 未写入文件，未执行 bun install——去掉 --dry-run 生效",
		);
		process.exit(0);
	}
	refreshWorkspace();
}

// --reset: 失败发布后的复位——把领先包写回 registry 基线。这是脚本里唯一
// 把版本号向下改的动作，且目标必是已发布的基线，永不产生新版本。
if (doReset) {
	if (behind.length > 0) {
		console.error(
			`✗ ${behind.map((r) => r.pkg).join(", ")} 落后 registry 基线——`,
		);
		console.error(
			"  先 bun run mono-sync -- --sync 对齐落后包，再考虑复位",
		);
		process.exit(1);
	}
	if (ahead.length === 0) {
		console.log("✓ 无包领先基线，无需复位");
		process.exit(0);
	}
	for (const r of ahead) {
		console.log(
			`${dryRun ? "[dry-run] " : ""}${r.pkg}: ${r.json.version} → ${r.base}`,
		);
		if (!dryRun) {
			r.json.version = r.base;
			writeJson(r.path, r.json);
		}
	}
	if (dryRun) {
		console.log(
			"[dry-run] 未写入文件，未执行 bun install——去掉 --dry-run 生效",
		);
		process.exit(0);
	}
	refreshWorkspace();
}

// 自动刷新 workspace: bun install 使 bun.lock 与改写后的 manifest 版本一致，
// 然后只读 git status 报告本地文件变动与脏状态（不做任何 git 写操作）。
// （bun update <workspace 成员> 对已发布成员会报 DependencyLoop，bun install
//   是 bun 原生的一致性对账入口——只重算锁文件，不改依赖 spec。）
function refreshWorkspace() {
	console.log("─".repeat(52));
	console.log("⧗ 自动刷新 workspace（bun install，对齐 bun.lock）...");
	const res = spawnSync("bun", ["install"], { cwd: root, stdio: "inherit" });
	if (res.status !== 0) {
		console.error("✗ bun install 失败——检查网络与 workspace 状态后重试");
		process.exit(1);
	}

	let status = "";
	try {
		status = execSync("git status --porcelain", {
			cwd: root,
			encoding: "utf8",
		}).trim();
	} catch (err) {
		console.warn(`⚠ 无法读取 git status（${err.message}）——请自行核对工作区`);
	}
	if (status) {
		console.warn("⚠ 本地文件已变动，仓库处于脏状态——请审查后按规范提交:");
		for (const line of status.split("\n").slice(0, 20)) {
			console.warn(`  ${line}`);
		}
		console.warn(
			'  提交建议: ./gcm -t chore -p <pkg> -m "align <pkg> with registry baseline"（显式 git add）',
		);
	} else {
		console.log("✓ workspace 已刷新，git 工作区无变动");
	}
}
