#!/usr/bin/env node
// mono-sync — keep the mono workspace's versions in lockstep with the npm
// registry.
//
// The root package.json and every package under packages/ must share one
// version. This helper checks, aligns, or sets them WITHOUT touching git
// (scripts/mono-release.mjs owns the commit/tag/push part of a release).
//
// Advancing versions is release semantics — that belongs to mono-release.
// The one mono-sync action that CHANGES versions is --sync, which aligns
// local manifests to the highest version already published on the registry,
// so a subsequent release always starts from the registry baseline (never
// collides with an existing version).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `mono-sync — 检查 / 对齐 mono workspace 版本号（纯文件操作，不碰 git）

用法:
  bun run mono-sync                   显示版本表与一致性状态
  bun run mono-sync -- --check        一致性门禁（不一致时 exit 1）
  bun run mono-sync -- --sync         对齐到 registry 最高已发布版本
  bun run mono-sync -- --set <版本>   全部 manifest 设为指定版本（X.Y.Z）
  bun run mono-sync -- --dry-run      预览不写入（与 --sync / --set 组合）
  bun run mono-sync -- --help         显示本帮助

说明:
  - 覆盖对象: 根 package.json + packages/*（由根 workspaces 自动展开）
  - 不提供 bump 操作: 推进版本号是 mono-release 的职责
  - --sync 拉齐到四包已发布最高版本; 本地高于 registry 时拒绝降级
  - --set 在本地版本不一致时拒绝覆盖（--dry-run 可安全预览）
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
const setIndex = args.indexOf("--set");
const targetVersion = setIndex !== -1 ? args[setIndex + 1] : undefined;
if (setIndex !== -1 && targetVersion === undefined) {
	console.error("✗ --set requires a version argument: --set X.Y.Z");
	process.exit(1);
}

const known = ["--dry-run", "--check", "--sync", "--set", targetVersion].filter(
	Boolean,
);
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

function dirList(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name !== "node_modules")
			.map((e) => e.name);
	} catch {
		return [];
	}
}

function existsSafe(path) {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

function packageManifests() {
	const rootManifest = {
		path: join(root, "package.json"),
		json: readJson(join(root, "package.json")),
	};
	const workspaces = rootManifest.json.workspaces ?? ["packages/*"];
	const members = [];
	for (const pattern of workspaces) {
		if (pattern.endsWith("/*")) {
			const dir = join(root, pattern.slice(0, -2));
			for (const entry of dirList(dir)) {
				const path = join(dir, entry, "package.json");
				if (existsSafe(path)) members.push({ path, json: readJson(path) });
			}
		} else {
			const path = join(root, pattern, "package.json");
			if (existsSafe(path)) members.push({ path, json: readJson(path) });
		}
	}
	return { root: rootManifest, members };
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

function registryUrl(name) {
	return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

async function publishedVersions(name) {
	try {
		const res = await fetch(registryUrl(name), {
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return [];
		const doc = await res.json();
		return Object.keys(doc.versions ?? {}).filter(isValidVersion);
	} catch {
		console.error(`✗ cannot reach registry for ${name}`);
		process.exit(1);
	}
}

async function highestPublished(manifests) {
	let highest = null;
	for (const m of manifests) {
		const versions = await publishedVersions(m.json.name);
		if (versions.length === 0) continue;
		const max = versions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b));
		if (highest === null || compareVersions(max, highest) > 0) highest = max;
	}
	return highest;
}

const { root: rootManifest, members } = packageManifests();
const manifests = [rootManifest, ...members];
const versions = manifests.map((m) => m.json.version);
const labels = manifests.map((m) => m.path.replace(root + "/", ""));

console.log("─".repeat(48));
for (let i = 0; i < manifests.length; i++) {
	console.log(`  ${labels[i].padEnd(34)} ${versions[i]}`);
}
console.log("─".repeat(48));

const consistent = new Set(versions).size === 1;
console.log(
	consistent ? "✓ 本地版本一致" : `✗ 本地版本不一致（${versions.join(" / ")}）`,
);

if (doCheck) {
	process.exit(consistent ? 0 : 1);
}

if (doSync) {
	const highest = await highestPublished(members);
	if (highest === null) {
		console.log(
			"registry 上还没有已发布的包（4 包均无版本记录），本地保持不变",
		);
		process.exit(0);
	}
	const ahead = versions.filter((v) => compareVersions(v, highest) > 0);
	if (ahead.length > 0) {
		console.error(
			`✗ 本地版本 ${ahead.join(", ")} 高于 registry 最高已发布版本 ${highest}`,
		);
		console.error(
			"  本地领先通常意味着上一次发布未完成；请先处理失败的发布，再考虑对齐",
		);
		process.exit(1);
	}
	const aligned = versions.every((v) => compareVersions(v, highest) === 0);
	if (aligned) {
		console.log(`✓ 已与 registry 对齐（最高已发布版本 ${highest}）`);
		process.exit(0);
	}
	console.log(
		`registry 最高已发布版本: ${highest}（本地 ${new Set(versions).size > 1 ? "不一致" : versions[0]}）`,
	);
	for (const m of manifests) {
		console.log(
			`${dryRun ? "[dry-run] " : ""}${m.path.replace(root + "/", "")}: ${m.json.version} → ${highest}`,
		);
		if (!dryRun) {
			m.json.version = highest;
			writeJson(m.path, m.json);
		}
	}
} else if (targetVersion !== undefined) {
	if (!isValidVersion(targetVersion)) {
		console.error(`✗ invalid version: ${targetVersion} (expects X.Y.Z)`);
		process.exit(1);
	}
	if (!consistent && !dryRun) {
		console.error(
			"✗ refusing to overwrite inconsistent versions; fix manually or use --dry-run to preview",
		);
		process.exit(1);
	}
	for (const m of manifests) {
		console.log(
			`${dryRun ? "[dry-run] " : ""}${m.path.replace(root + "/", "")}: ${m.json.version} → ${targetVersion}`,
		);
		if (!dryRun) {
			m.json.version = targetVersion;
			writeJson(m.path, m.json);
		}
	}
}
