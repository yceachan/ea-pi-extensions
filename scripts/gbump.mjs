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
  ${command("./gbump")} ${option("-p")} ${value("<package>")} ${option("--initial")} [${option("--login")}] [${option("--dry-run | --yes")}]
  ${command("./gbump")} ${option("-p")} ${value("<pkg>")} ${option("--minor -p")} ${value("<pkg>")} ${option("--patch")} [${option("--dry-run")}]

${heading("示例")}
  ${command("./gbump -p pi-gadget --patch --dry-run")}
  ${command("./gbump -p pi-gadget --set-ver 0.5.0")}
  ${command("./gbump -p pi-new --initial --dry-run")}
  ${command("./gbump -p pi-new --initial --login")}
  ${command("./gbump -p pi-gadget --minor -p pi-shelld --patch")}

${heading("参数")}
  ${option("-p")} ${value("<package>")}          package 名；可重复，每包独立指定版本模式
  ${option("--patch")}               patch 版本
  ${option("--minor")}               minor 版本
  ${option("--major")}               major 版本
  ${option("--set-ver")} ${value("<X.Y.Z>")}    指定版本
  ${option("--initial")}             发布 manifest 当前版本（仅单包）
  ${option("--login")}               initial 缺少登录时打印 npm 浏览器授权链接
  ${option("--dry-run")}             运行检查，不写入
  ${option("-y, --yes")}             接受唯一模糊匹配；授权非 TTY initial 发布
  ${option("-h, --help")}            显示帮助

${heading("规则")}
  - regular 发布要求 registry 基线；新 package 使用 ${option("--initial")}。
  - 发布要求 clean worktree 和有效 changelog。
  - initial 在 TTY 输入完整 tag；非 TTY 使用 ${option("--yes")}。
  - 多包共用一个 release commit；commit 和 tag 一次 atomic push。

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
const specs = [];
let current = { pkg: null, mode: null, setVer: null };
let dryRun = false;
let yes = false;
let login = false;

for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "-p") {
		if (i + 1 >= args.length || args[i + 1].startsWith("-"))
			fail("-p requires a package name");
		if (current.pkg !== null) {
			specs.push(current);
			current = { pkg: null, mode: null, setVer: null };
		}
		current.pkg = args[++i];
	} else if (a === "--dry-run") {
		dryRun = true;
	} else if (a === "-y" || a === "--yes") {
		yes = true;
	} else if (a === "--login") {
		login = true;
	} else if (
		a === "--patch" ||
		a === "--minor" ||
		a === "--major" ||
		a === "--initial"
	) {
		if (current.mode !== null) fail(`conflicting version flags (already ${current.mode})`);
		current.mode = a.slice(2);
	} else if (a === "--set-ver") {
		if (current.mode !== null) fail(`conflicting version flags (already ${current.mode})`);
		if (i + 1 >= args.length || args[i + 1].startsWith("-"))
			fail("--set-ver requires a version: --set-ver X.Y.Z");
		current.setVer = args[++i];
		current.mode = "set-ver";
	} else {
		fail(`unknown argument: ${a}`);
	}
}
specs.push(current);
for (const spec of specs) {
	if (spec.pkg === null) fail("-p <package> is required");
	if (spec.mode === null) fail(`missing release mode after ${spec.pkg}`);
}
const initial = specs.some((spec) => spec.mode === "initial");
if (initial && specs.length !== 1) fail("--initial is exclusive and releases exactly one package");
if (login && !initial) fail("--login requires --initial");

// Resolve every scope before delegating once: one batch, one release commit.
const mArgs = [];
const seen = new Set();
for (const spec of specs) {
	const pkg = await resolvePackageScope(spec.pkg, { root, yes, fail, warn });
	if (seen.has(pkg)) fail(`package listed twice: ${pkg}`);
	seen.add(pkg);
	mArgs.push(pkg);
	if (spec.mode === "set-ver") mArgs.push("--set-ver", spec.setVer);
	else if (spec.mode === "initial") mArgs.push("--initial");
	else mArgs.push(spec.mode);
}
if (dryRun) mArgs.push("--dry-run");
if (yes && initial) mArgs.push("--yes");
if (login) mArgs.push("--login");
const res = spawnSync("bun", ["scripts/mono-release.mjs", ...mArgs], {
	cwd: root,
	stdio: "inherit",
});
process.exit(res.status ?? 1);
