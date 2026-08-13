#!/usr/bin/env bun
// gbump — 手工发版一键入口（薄壳）。
//
// 只做 gbump 命令行参数 → mono-release 位置参数的翻译，然后直接委托
// scripts/mono-release.mjs 执行发版仪式。旧 gbump 的三项预检（干净工作区 /
// 本地版本 == registry 基线 / changelog 就绪且非空）已并入 mono-release
// 的守卫——守卫与发版仪式全仓库只有一份实现。
//
// changelog 骨架由 ./gcm -c 创建（见 scripts/gcm.mjs）。
//
// 规范: docs/发行版本控制策略.md | 实现: scripts/mono-release.mjs

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `gbump — 手工发版一键入口（等价 mono-release 完整守卫 + 发版仪式）

用法:
  ./gbump -p <package> [--patch | --minor | --major | --set-ver <X.Y.Z>] [--dry-run]
  ./gbump --help

说明:
  - 薄壳: 把 gbump 参数翻译为 mono-release 的位置参数后直接委托
    scripts/mono-release.mjs；守卫与发版仪式全在 mono-release 一份实现
  - 守卫（mono-release）: 干净工作区 → 逐包（本地版本 == registry 基线 →
    自上个逐包 tag 有实质变更（无基线仅告警）→ changelog/<pkg>/v<ver>/log.md
    已存在且含实质条目 → tag 未在本地存在）
  - changelog 骨架由 ./gcm -c 创建（见 scripts/gcm.mjs）
`;

const args = process.argv.slice(2);

// --help/-h only win when they are the ONLY arguments (same rule as
// mono-release — a stray help flag must never swallow a release command).
const helpOnly =
	args.length > 0 && args.every((a) => a === "--help" || a === "-h");
if (args.length === 0 || helpOnly) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

function fail(msg) {
	console.error(`✗ ${msg}`);
	console.error("  Run ./gbump --help for usage.");
	process.exit(1);
}

// ── gbump flags → mono-release positional args ────────────────────────────
let pkg = null;
let dryRun = false;
let mode = null; // "patch" | "minor" | "major" | "set-ver"
let setVer = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-p") {
		if (pkg !== null) fail("duplicate -p");
		if (i + 1 >= args.length) fail("-p requires a package name");
		pkg = args[++i];
	} else if (a === "--dry-run") {
		dryRun = true;
	} else if (a === "--patch" || a === "--minor" || a === "--major") {
		if (mode !== null) fail(`conflicting version flags (already ${mode})`);
		mode = a.slice(2);
	} else if (a === "--set-ver") {
		if (mode !== null) fail(`conflicting version flags (already ${mode})`);
		if (i + 1 >= args.length)
			fail("--set-ver requires a version: --set-ver X.Y.Z");
		setVer = args[++i];
		mode = "set-ver";
	} else {
		fail(`unknown argument: ${a}`);
	}
}
if (pkg === null) fail("-p <package> is required");
if (mode === null)
	fail(
		"missing version flag: --patch | --minor | --major | --set-ver <X.Y.Z>",
	);

const mArgs = [
	pkg,
	...(mode === "set-ver" ? ["--set-ver", setVer] : [mode]),
	...(dryRun ? ["--dry-run"] : []),
];
const res = spawnSync("bun", ["scripts/mono-release.mjs", ...mArgs], {
	cwd: root,
	stdio: "inherit",
});
process.exit(res.status ?? 1);
