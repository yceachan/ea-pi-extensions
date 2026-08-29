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
import { resolvePackageScope } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const colorsAllowed = process.env.NO_COLOR === undefined;
const forceColor = process.env.FORCE_COLOR === "1";
const useHelpColor = colorsAllowed && (process.stdout.isTTY || forceColor);
const useErrorColor = colorsAllowed && (process.stderr.isTTY || forceColor);
const paint = (code, text) =>
	useHelpColor ? `\u001B[${code}m${text}\u001B[0m` : text;
const heading = (text) => paint("1;32", text);
const option = (text) => paint("1;32", text);
const value = (text) => paint("32", text);
const command = (text) => paint("32", text);
const errorText = (text) =>
	useErrorColor ? `\u001B[31m${text}\u001B[0m` : text;
const warningText = (text) =>
	useErrorColor ? `\u001B[33m${text}\u001B[0m` : text;

const HELP = `${heading("gbump")} — package 发布工具

${heading("用法")}
  ${command("./gbump")} ${option("-p")} ${value("<package>")} (${option("--patch | --minor | --major | --set-ver")} ${value("<X.Y.Z>")}) [${option("--dry-run")}]
  ${command("./gbump")} ${option("-p")} ${value("<package>")} ${option("--initial")} [${option("--dry-run | --yes")}]

${heading("示例")}
  ${command("./gbump -p pi-gadget --patch --dry-run")}
  ${command("./gbump -p pi-gadget --set-ver 0.5.0")}
  ${command("./gbump -p pi-new --initial --dry-run")}
  ${command("./gbump -p pi-new --initial")}

${heading("参数")}
  ${option("-p")} ${value("<package>")}          package 名；支持模糊匹配
  ${option("--patch")}               patch 版本
  ${option("--minor")}               minor 版本
  ${option("--major")}               major 版本
  ${option("--set-ver")} ${value("<X.Y.Z>")}    指定版本
  ${option("--initial")}             发布 manifest 当前版本
  ${option("--dry-run")}             运行检查，不写入
  ${option("-y, --yes")}             接受唯一模糊匹配；授权非 TTY initial 发布
  ${option("-h, --help")}            显示帮助

${heading("规则")}
  - regular 发布要求 registry 基线；新 package 使用 ${option("--initial")}。
  - 发布要求 clean worktree 和有效 changelog。
  - initial 在 TTY 输入完整 tag；非 TTY 使用 ${option("--yes")}。

${heading("退出码")}  ${value("0")} 成功  ${value("1")} 失败
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
	process.stderr.write(`${errorText(`✗ ${msg}\n  ./gbump --help`)}\n`);
	process.exit(1);
}

function warn(msg) {
	process.stderr.write(`${warningText(`⚠ ${msg}`)}\n`);
}

// ── gbump flags → mono-release positional args ────────────────────────────
let pkg = null;
let dryRun = false;
let yes = false;
let mode = null; // "patch" | "minor" | "major" | "set-ver" | "initial"
let setVer = null;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-p") {
		if (pkg !== null) fail("duplicate -p");
		if (i + 1 >= args.length) fail("-p requires a package name");
		pkg = args[++i];
	} else if (a === "--dry-run") {
		dryRun = true;
	} else if (a === "-y" || a === "--yes") {
		yes = true;
	} else if (
		a === "--patch" ||
		a === "--minor" ||
		a === "--major" ||
		a === "--initial"
	) {
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
		"missing release mode: --patch | --minor | --major | --set-ver <X.Y.Z> | --initial",
	);

// -p 模糊解析（与 gcm -p 同一份实现）→ 解析出完整包名后再委托 mono-release；
// mono-release 保持精确匹配（批式位置参数 CLI，模糊化会让多包解析歧义）。
pkg = await resolvePackageScope(pkg, { root, yes, fail, warn });

let releaseArgs;
if (mode === "set-ver") releaseArgs = ["--set-ver", setVer];
else if (mode === "initial") releaseArgs = ["--initial"];
else releaseArgs = [mode];

const mArgs = [
	pkg,
	...releaseArgs,
	...(dryRun ? ["--dry-run"] : []),
	...(yes && mode === "initial" ? ["--yes"] : []),
];
const res = spawnSync("bun", ["scripts/mono-release.mjs", ...mArgs], {
	cwd: root,
	stdio: "inherit",
});
process.exit(res.status ?? 1);
