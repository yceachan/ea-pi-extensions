#!/usr/bin/env bun
// gbump — 手工发版一键入口（预检 → 委托 mono-release 发版仪式）。
//
// 三项预检全部通过才执行发版仪式:
//   1. monorepo 干净（git status --porcelain 为空）
//   2. 包本地版本 == 其 registry 基线（落后 → 提示 version:sync；领先 → 提示容灾）
//   3. changelog/<pkg>/v<ver>/log.md 已存在且含实质条目（骨架由 ./gcm -c 生成）
//
// 发版仪式本身由 scripts/mono-release.mjs 执行（bump/--set-ver → 提交 → tag → push）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const HELP = `gbump — 手工发版一键入口（预检 → 委托 mono-release 仪式）

用法:
  ./gbump -p <package> [--patch | --minor | --major | --set-ver <vX.Y.Z>]
  ./gbump -p <package> [--patch | --minor | --major | --set-ver <vX.Y.Z>] --dry-run
  ./gbump --help

预检（全部通过才执行发版仪式）:
  1. monorepo 干净（git status --porcelain 为空）
  2. 包本地版本 == 其 registry 基线
     落后 → 先 bun run version:sync；领先 → 发版未完成，按容灾手册处理
  3. changelog/<pkg>/v<ver>/log.md 已存在且含实质条目
     骨架由 ./gcm -c 生成，不含 "- " 条目——须手工填写实质条目

发版仪式: bun scripts/mono-release.mjs <pkg> <bump|--set-ver <ver>>
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

// ── 参数解析 ─────────────────────────────────────────────────────────────
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
		"missing version flag: --patch | --minor | --major | --set-ver <vX.Y.Z>",
	);

function fail(msg) {
	console.error(`✗ ${msg}`);
	console.error("  Run ./gbump --help for usage.");
	process.exit(1);
}

// ── 工具函数 ─────────────────────────────────────────────────────────────
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`✗ cannot read ${path}: ${err.message}`);
		process.exit(1);
	}
}

function runCapture(cmd) {
	try {
		return execSync(cmd, { cwd: root, encoding: "utf8" });
	} catch {
		return "";
	}
}

function isValidVersion(v) {
	return /^\d+\.\d+\.\d+$/.test(v);
}

function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

function packages() {
	const dir = join(root, "packages");
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== "node_modules")
		.map((e) => e.name)
		.filter((name) => existsSync(join(dir, name, "package.json")));
}

async function registryMax(name) {
	try {
		const res = await fetch(
			`https://registry.npmjs.org/${name.replace("/", "%2F")}`,
			{ signal: AbortSignal.timeout(10000) },
		);
		if (!res.ok) return null;
		const doc = await res.json();
		const versions = Object.keys(doc.versions ?? {}).filter(isValidVersion);
		if (versions.length === 0) return null;
		return versions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b));
	} catch {
		return "unreachable";
	}
}

// ── 包与目标版本 ─────────────────────────────────────────────────────────
const manifestPath = join(root, "packages", pkg, "package.json");
if (!existsSync(manifestPath)) {
	console.error(`✗ no such package: ${pkg}`);
	console.error(`  available: ${packages().join(", ")}`);
	process.exit(1);
}
const manifest = readJson(manifestPath);
if (!isValidVersion(manifest.version)) {
	console.error(`✗ invalid current version for ${pkg}: ${manifest.version}`);
	process.exit(1);
}
const current = manifest.version;

const target =
	mode === "set-ver"
		? (() => {
				if (!isValidVersion(setVer)) {
					console.error(`✗ invalid version: ${setVer} (expects X.Y.Z)`);
					process.exit(1);
				}
				if (compareVersions(setVer, current) <= 0) {
					console.error(
						`✗ target ${setVer} is not greater than current ${current}`,
					);
					process.exit(1);
				}
				return setVer;
			})()
		: (() => {
				const [major, minor, patch] = current.split(".").map(Number);
				return mode === "major"
					? `${major + 1}.0.0`
					: mode === "minor"
						? `${major}.${minor + 1}.0`
						: `${major}.${minor}.${patch + 1}`;
			})();

// ── 预检 2: 本地版本 == registry 基线 ─────────────────────────────────────
const base = await registryMax(`@yceachan/${pkg}`);
if (base === null) {
	console.warn(
		`⚠ registry 无 @yceachan/${pkg} 版本记录（新包需先种子发布，见策略文档）`,
	);
} else if (base === "unreachable") {
	console.warn("⚠ registry unreachable; skipping baseline consistency check");
} else if (compareVersions(current, base) < 0) {
	console.error(
		`✗ ${pkg} 本地 ${current} 落后 registry 基线 ${base} ——先对齐:`,
	);
	console.error(
		"    bun run version:sync -- --dry-run   （确认后去掉 --dry-run）",
	);
	process.exit(1);
} else if (compareVersions(current, base) > 0) {
	console.error(
		`✗ ${pkg} 本地 ${current} 领先 registry 基线 ${base} ——发版未完成?`,
	);
	console.error("  按 docs/tag回退与CI容灾.md 处理失败的发布，不要继续发版");
	process.exit(1);
}

// ── changelog ────────────────────────────────────────────────────────────
const changelogPath = join(root, "changelog", pkg, `v${target}`, "log.md");

// ── 预检 1: monorepo 干净 ────────────────────────────────────────────────
const dirty = runCapture(`git status --porcelain`).trim();
if (dirty.length > 0) {
	console.error("✗ working tree is not clean — commit or stash first:");
	for (const line of dirty.split("\n").slice(0, 10)) console.error(`  ${line}`);
	process.exit(1);
}

// ── 预检 3: changelog 已就绪且含实质条目 ───────────────────────────────────
if (!existsSync(changelogPath)) {
	console.error(`✗ changelog 缺失: ${changelogPath}`);
	console.error(
		`  先创建骨架: ./gcm -c -p ${pkg} --${mode}${mode === "set-ver" ? ` ${setVer}` : ""}`,
	);
	process.exit(1);
}
const content = readFileSync(changelogPath, "utf8");
const hasEntry = content
	.split("\n")
	.some((line) => /^\s*-\s+\S/.test(line) && !line.includes("<!--"));
if (!hasEntry) {
	console.error(`✗ changelog 为空（骨架不含 "- " 条目）: ${changelogPath}`);
	console.error("  填写实质条目后再发版");
	process.exit(1);
}

console.log("─".repeat(56));
console.log(`  ✓ 预检通过: ${pkg} ${current} → ${target} (${mode})`);
console.log("─".repeat(56));

// ── 委托 mono-release 执行发版仪式 ─────────────────────────────────────────
const spec = mode === "set-ver" ? ["--set-ver", setVer] : [mode];
const mArgs = [pkg, ...spec, ...(dryRun ? ["--dry-run"] : [])];
const res = spawnSync("bun", ["scripts/mono-release.mjs", ...mArgs], {
	cwd: root,
	stdio: "inherit",
});
process.exit(res.status ?? 1);
