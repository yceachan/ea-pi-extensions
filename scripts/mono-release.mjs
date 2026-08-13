#!/usr/bin/env bun
// mono-release — per-package release ceremony: bump ONLY the named packages,
// surgically sync bun.lock's workspace version fields, commit one
// "release: <tag1>, <tag2>..." commit, tag each package with "<pkg>@<ver>",
// and push. Each tag is its own publish instruction; CI (publish.yml)
// parses the tag and publishes exactly that package@version.
//
// Per-package model (see docs/发行版本控制策略.md): packages share no version;
// each advances its own semver by its own change type.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareVersions,
	gitDirty,
	isValidVersion,
	readJson,
	registryBaseline,
	runCapture,
	syncLockfileWorkspaceVersions,
	writeJson,
} from "./lib.mjs";

const HELP = `mono-release — 逐包发版仪式（bump + 锁文件同步 + release 提交 + 逐包 tag + push）

用法:
  bun run mono-release -- --help
  bun run mono-release -- pi-gadget minor
  bun run mono-release -- pi-gadget minor pi-shelld patch
  bun run mono-release -- pi-gadget --set-ver 0.5.0
  bun run mono-release -- pi-gadget minor --dry-run

说明:
  - 逐包独立版本: 每个包按自己的变更类型推进（patch=修 bug / minor=新功能 /
    major=破坏性），或 --set-ver 显式指定目标版本（须高于当前）；
    一次调用可发多包 = 一个 release 提交 + N 个 tag
  - tag 格式 <pkg>@<ver>（如 pi-gadget@0.3.0）; CI 以 tag 为唯一发布指令
  - 守卫: 干净工作区 → 逐包（本地版本 == registry 基线 → 该包自上个逐包
    tag 以来有实质变更（无基线时仅告警）→ changelog/<pkg>/v<ver>/log.md
    已存在且含实质条目 → tag 未在本地存在）
  - --dry-run: 完整走查守卫并打印计划，不写文件、不碰 git

前置条件: git 远端已配置; changelog 按纪律手工提交（docs/changelog: 见提交规范）
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

// --help/-h only win when they are the ONLY arguments. A stray help flag
// must never swallow real release specs: the package.json run-script entry
// used to inject --help into argv, so every documented
// `bun run mono-release -- <pkg> <bump>` printed help and exited 0 without
// releasing.
const helpOnly =
	args.length > 0 && args.every((a) => a === "--help" || a === "-h");
if (args.length === 0 || helpOnly) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

const dryRun = args.includes("--dry-run");
const items = args.filter((a) => a !== "--dry-run");

// Parse per-package specs: <pkg> <bump> or <pkg> --set-ver <version>.
const specs = [];
for (let i = 0; i < items.length; ) {
	const pkg = items[i];
	if (pkg.startsWith("--")) {
		console.error(`✗ unknown argument: ${pkg}`);
		process.exit(1);
	}
	if (i + 1 >= items.length) {
		console.error(
			`✗ missing bump after ${pkg} (expects <pkg> patch|minor|major, or <pkg> --set-ver X.Y.Z)`,
		);
		process.exit(1);
	}
	const spec = items[i + 1];
	if (spec === "--set-ver") {
		if (i + 2 >= items.length || items[i + 2].startsWith("--")) {
			console.error("✗ --set-ver requires a version: <pkg> --set-ver X.Y.Z");
			process.exit(1);
		}
		specs.push({ pkg, bump: null, setVer: items[i + 2] });
		i += 3;
	} else {
		specs.push({ pkg, bump: spec, setVer: null });
		i += 2;
	}
}
if (specs.length === 0) {
	console.error(
		"✗ expects at least one package, e.g. \"mono-release -- pi-gadget minor\"",
	);
	process.exit(1);
}

const BUMPS = new Set(["patch", "minor", "major"]);

function run(cmd) {
	try {
		execSync(cmd, { cwd: root, stdio: "inherit" });
	} catch {
		console.error(`✗ command failed: ${cmd}`);
		process.exit(1);
	}
}

// Resolve each spec into a plan entry: { pkg, bump, manifest, from, to, tag }.
const plans = [];
const seen = new Set();
for (const spec of specs) {
	const { pkg, bump, setVer } = spec;
	if (seen.has(pkg)) {
		console.error(`✗ package listed twice: ${pkg}`);
		process.exit(1);
	}
	seen.add(pkg);
	const manifestPath = join(root, "packages", pkg, "package.json");
	if (!existsSync(manifestPath)) {
		console.error(`✗ no such package: ${pkg} (${manifestPath})`);
		process.exit(1);
	}
	const json = readJson(manifestPath);
	if (!isValidVersion(json.version)) {
		console.error(`✗ invalid current version for ${pkg}: ${json.version}`);
		process.exit(1);
	}
	let to;
	if (setVer !== null) {
		if (!isValidVersion(setVer)) {
			console.error(`✗ invalid version for ${pkg}: ${setVer} (expects X.Y.Z)`);
			process.exit(1);
		}
		if (compareVersions(setVer, json.version) <= 0) {
			console.error(
				`✗ target ${setVer} is not greater than current ${json.version} for ${pkg}`,
			);
			process.exit(1);
		}
		to = setVer;
	} else {
		if (!BUMPS.has(bump)) {
			console.error(
				`✗ invalid bump for ${pkg}: ${bump} (expects patch|minor|major)`,
			);
			process.exit(1);
		}
		const [major, minor, patch] = json.version.split(".").map(Number);
		to =
			bump === "major"
				? `${major + 1}.0.0`
				: bump === "minor"
					? `${major}.${minor + 1}.0`
					: `${major}.${minor}.${patch + 1}`;
	}
	plans.push({
		pkg,
		bump: bump ?? `--set-ver ${setVer}`,
		manifestPath,
		json,
		from: json.version,
		to,
		tag: `${pkg}@${to}`,
	});
}

// ── Guard 1: clean working tree ──────────────────────────────────────────
const dirty = gitDirty(root);
if (dirty.length > 0) {
	console.error("✗ working tree is not clean — commit or stash first:");
	for (const line of dirty.split("\n").slice(0, 10)) console.error(`  ${line}`);
	process.exit(1);
}

// ── Guards 2–5: per package ──────────────────────────────────────────────
let failed = false;
for (const plan of plans) {
	// Guard 2: the local version must equal this package's registry
	// baseline. A release always starts from the baseline, so the bumped
	// target is necessarily unpublished — this one check covers both the
	// "local behind" and the "unfinished release" failure modes (the
	// former gbump precheck 2) and makes a separate target-already-
	// published check redundant.
	const base = await registryBaseline(`@yceachan/${plan.pkg}`);
	if (base.status === "unreachable") {
		console.warn("⚠ registry unreachable; skipping baseline consistency check");
	} else if (base.status === "unknown") {
		console.warn(
			`⚠ @yceachan/${plan.pkg} has no registry versions — seed the first release manually first`,
		);
	} else if (compareVersions(plan.from, base.max) < 0) {
		console.error(
			`✗ ${plan.pkg} 本地 ${plan.from} 落后 registry 基线 ${base.max} ——先对齐:`,
		);
		console.error(
			"    bun run version:sync -- --dry-run   （确认后去掉 --dry-run）",
		);
		failed = true;
	} else if (compareVersions(plan.from, base.max) > 0) {
		console.error(
			`✗ ${plan.pkg} 本地 ${plan.from} 领先 registry 基线 ${base.max} ——发版未完成?`,
		);
		console.error(
			"  按 docs/tag回退与CI容灾.md 处理失败的发布，不要继续发版",
		);
		failed = true;
	}

	// Guard 3: the package must have changed since its last package tag.
	// No prior <pkg>@* tag = first per-package release → no baseline, warn only.
	const lastTag = runCapture(
		`git describe --match "${plan.pkg}@*" --abbrev=0 HEAD 2>/dev/null || true`,
		root,
	).trim();
	if (lastTag) {
		const changed = runCapture(
			`git diff --name-only ${lastTag}..HEAD -- packages/${plan.pkg}/`,
			root,
		).trim();
		if (changed.length === 0) {
			console.error(
				`✗ packages/${plan.pkg}/ unchanged since ${lastTag} — nothing to publish`,
			);
			failed = true;
		}
	} else {
		console.warn(
			`⚠ ${plan.pkg} has no prior package tag — skipping changed-since guard`,
		);
	}

	// Guard 4: changelog discipline — the target version's release notes
	// must exist AND contain real entries (the gcm -c skeleton has none,
	// so an unfilled scaffold cannot ship).
	const notes = join(root, "changelog", plan.pkg, `v${plan.to}`, "log.md");
	const modeHint = plan.bump.startsWith("--set-ver")
		? plan.bump
		: `--${plan.bump}`;
	if (!existsSync(notes)) {
		console.error(`✗ changelog 缺失: ${notes}`);
		console.error(`  先创建骨架: ./gcm -c -p ${plan.pkg} ${modeHint}`);
		failed = true;
	} else {
		const content = readFileSync(notes, "utf8");
		const hasEntry = content
			.split("\n")
			.some((line) => /^\s*-\s+\S/.test(line) && !line.includes("<!--"));
		if (!hasEntry) {
			console.error(`✗ changelog 为空（骨架不含 "- " 条目）: ${notes}`);
			console.error("  填写实质条目后再发版");
			failed = true;
		}
	}

	// Guard 5: the tag must not already exist locally.
	if (
		runCapture(`git rev-parse -q --verify "refs/tags/${plan.tag}"`, root).trim()
	) {
		console.error(`✗ local tag already exists: ${plan.tag}`);
		failed = true;
	}
}
if (failed) process.exit(1);

// ── Plan preview ─────────────────────────────────────────────────────────
console.log("─".repeat(60));
for (const plan of plans) {
	console.log(
		`  @yceachan/${plan.pkg}  ${plan.from} → ${plan.to}  (${plan.bump})  tag ${plan.tag}`,
	);
}
const commitMessage = `release: ${plans.map((p) => p.tag).join(", ")}`;
console.log(`  commit: ${commitMessage}`);
console.log(
	`  bun.lock: 同步 workspace 版本字段（${plans.map((p) => p.pkg).join(", ")}）`,
);
console.log("─".repeat(60));

if (dryRun) {
	console.log("[dry-run] no writes, no git operations performed");
	process.exit(0);
}

for (const plan of plans) {
	plan.json.version = plan.to;
	writeJson(plan.manifestPath, plan.json);
}

// 锁文件跟随: bun.lock 记录每个 workspace 成员的 version。只做手术式字段
// 改写（等价于 bun install 会写的那一行），不跑 bun install——避免 devDeps
// 的 "latest" 被重新解析、把无关依赖变动夹带进 release 提交。
syncLockfileWorkspaceVersions(
	join(root, "bun.lock"),
	Object.fromEntries(plans.map((p) => [p.pkg, p.to])),
);

run(`git add ${plans.map((p) => p.manifestPath).join(" ")} bun.lock`);
run(`git commit -m "${commitMessage}"`);
for (const plan of plans) run(`git tag ${plan.tag}`);
run(`git push && git push --tags`);
console.log(
	`✓ Released ${plans.map((p) => p.tag).join(", ")}. CI will publish each tagged package.`,
);
