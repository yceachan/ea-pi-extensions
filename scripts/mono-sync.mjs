#!/usr/bin/env bun
// mono-sync — per-package alignment with the npm registry.
//
// Packages share no version under the per-package model; each one must not
// fall behind its own registry baseline (its highest published version).
// This helper checks, reports, or aligns each package's manifest version to
// that baseline WITHOUT touching git (scripts/mono-release.mjs owns the
// commit/tag/push part of a release).
//
// Advancing versions is release semantics — that belongs to mono-release.
// The one action that CHANGES versions here is --sync: it aligns a package
// that is behind its registry baseline up to that baseline. A package ahead
// of its baseline means an unfinished release; --sync refuses to downgrade.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `mono-sync — 逐包检查 / 对齐 registry 基线（纯文件操作，不碰 git）

用法:
  bun run mono-sync                    显示每包本地版本 vs registry 基线
  bun run mono-sync -- --check         门禁（有包低于基线时 exit 1）
  bun run mono-sync -- --sync          落后包对齐到自己的 registry 基线
  bun run mono-sync -- --sync --dry-run  预览不写入
  bun run mono-sync -- --help          显示本帮助

说明:
  - 覆盖对象: packages/*（根 manifest 无版本，不参与）
  - 逐包独立版本: 基线 = 该包在 registry 的最高已发布版本
  - 本地高于基线 = 发版未完成，--sync 拒绝降级（--check 仅告警）
  - 不提供 bump / --set: 推进版本号是 mono-release 的职责
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 0) {
	console.log(HELP);
	process.exit(1);
}
if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}

const dryRun = args.includes("--dry-run");
const doCheck = args.includes("--check");
const doSync = args.includes("--sync");

const known = ["--dry-run", "--check", "--sync", "--help", "-h"];
const unknown = args.filter((a) => !known.includes(a));
if (unknown.length > 0) {
	console.error(`✗ unknown argument(s): ${unknown.join(", ")}`);
	console.error("  Run mono-sync --help for usage.");
	process.exit(1);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`✗ cannot read ${path}: ${err.message}`);
		process.exit(1);
	}
}

function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
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

function isValidVersion(version) {
	return /^\d+\.\d+\.\d+$/.test(version);
}

function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

async function highestPublished(name) {
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
		console.error(`✗ cannot reach registry for ${name}`);
		process.exit(1);
	}
}

const members = packageMembers();
const baselines = new Map();
for (const m of members) {
	baselines.set(m.pkg, await highestPublished(`@yceachan/${m.pkg}`));
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
	if (behind.length > 0)
		console.log(`✗ 落后基线: ${behind.map((r) => r.pkg).join(", ")}`);
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
}
