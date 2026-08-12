#!/usr/bin/env bun
// mono-release — per-package release ceremony: bump ONLY the named packages,
// commit one "release: <tag1>, <tag2>..." commit, tag each package with
// "<pkg>@<ver>", and push. Each tag is its own publish instruction; CI
// (publish.yml) parses the tag and publishes exactly that package@version.
//
// Per-package model (see docs/发行版本控制策略.md): packages share no version;
// each advances its own semver by its own change type.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `mono-release — 逐包发版仪式（bump + release 提交 + 逐包 tag + push）

用法:
  bun run mono-release -- --help
  bun run mono-release -- pi-gadget minor
  bun run mono-release -- pi-gadget minor pi-shelld patch
  bun run mono-release -- pi-gadget minor --dry-run

说明:
  - 逐包独立版本: 每个包按自己的变更类型推进（patch=修 bug / minor=新功能 /
    major=破坏性），一次调用可发多包 = 一个 release 提交 + N 个 tag
  - tag 格式 <pkg>@<ver>（如 pi-gadget@0.3.0）; CI 以 tag 为唯一发布指令
  - 守卫（逐包）: 干净工作区 → 目标版本未在该包 registry 存在 →
    该包自上个逐包 tag 以来有实质变更（无基线时仅告警）→
    changelog/<pkg>/v<ver>/log.md 缺失仅告警
  - --dry-run: 完整走查守卫并打印计划，不写文件、不碰 git

前置条件: git 远端已配置; changelog 按纪律手工提交（docs/changelog: 见提交规范）
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

const dryRun = args.includes("--dry-run");
const pairs = [];
for (const a of args) {
	if (a === "--dry-run") continue;
	if (a.startsWith("--")) {
		console.error(`✗ unknown argument: ${a}`);
		process.exit(1);
	}
	pairs.push(a);
}
if (pairs.length === 0 || pairs.length % 2 !== 0) {
	console.error(
		"✗ expects an even list of <pkg> <bump> pairs, e.g. \"mono-release -- pi-gadget minor\"",
	);
	process.exit(1);
}

const BUMPS = new Set(["patch", "minor", "major"]);

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

function run(cmd) {
	try {
		execSync(cmd, { cwd: root, stdio: "inherit" });
	} catch {
		console.error(`✗ command failed: ${cmd}`);
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

function isValidVersion(version) {
	return /^\d+\.\d+\.\d+$/.test(version);
}

async function alreadyPublished(name, version) {
	try {
		const res = await fetch(
			`https://registry.npmjs.org/${name.replace("/", "%2F")}`,
			{ signal: AbortSignal.timeout(10000) },
		);
		if (!res.ok) return false;
		const doc = await res.json();
		return Object.keys(doc.versions ?? {}).some(
			(v) => isValidVersion(v) && v === version,
		);
	} catch {
		console.warn("⚠ registry unreachable; skipping pre-flight version check");
		return false;
	}
}

// Resolve each pair into a plan entry: { pkg, bump, manifest, from, to, tag }.
const plans = [];
const seen = new Set();
for (let i = 0; i < pairs.length; i += 2) {
	const [pkg, bump] = [pairs[i], pairs[i + 1]];
	if (seen.has(pkg)) {
		console.error(`✗ package listed twice: ${pkg}`);
		process.exit(1);
	}
	seen.add(pkg);
	if (!BUMPS.has(bump)) {
		console.error(`✗ invalid bump for ${pkg}: ${bump} (expects patch|minor|major)`);
		process.exit(1);
	}
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
	const [major, minor, patch] = json.version.split(".").map(Number);
	const to =
		bump === "major"
			? `${major + 1}.0.0`
			: bump === "minor"
				? `${major}.${minor + 1}.0`
				: `${major}.${minor}.${patch + 1}`;
	plans.push({
		pkg,
		bump,
		manifestPath,
		json,
		from: json.version,
		to,
		tag: `${pkg}@${to}`,
	});
}

// ── Guard 1: clean working tree ──────────────────────────────────────────
const dirty = runCapture(`git status --porcelain`).trim();
if (dirty.length > 0) {
	console.error("✗ working tree is not clean — commit or stash first:");
	for (const line of dirty.split("\n").slice(0, 10)) console.error(`  ${line}`);
	process.exit(1);
}

// ── Guards 2–4: per package ──────────────────────────────────────────────
let failed = false;
for (const plan of plans) {
	// Guard 2: target version must not already exist on the registry for
	// this package (a hit means local is behind the registry baseline).
	if (await alreadyPublished(`@yceachan/${plan.pkg}`, plan.to)) {
		console.error(
			`✗ @yceachan/${plan.pkg}@${plan.to} already published — local is behind`,
		);
		console.error("  the registry baseline. Align first:");
		console.error("    bun run version:sync -- --dry-run");
		failed = true;
	}

	// Guard 3: the package must have changed since its last package tag.
	// No prior <pkg>@* tag = first per-package release → no baseline, warn only.
	const lastTag = runCapture(
		`git describe --match "${plan.pkg}@*" --abbrev=0 HEAD 2>/dev/null || true`,
	).trim();
	if (lastTag) {
		const changed = runCapture(
			`git diff --name-only ${lastTag}..HEAD -- packages/${plan.pkg}/`,
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

	// Guard 4: changelog discipline — missing notes only warn (manual, see
	// docs/git提交规范.md).
	if (!existsSync(join(root, "changelog", plan.pkg, `v${plan.to}`, "log.md"))) {
		console.warn(
			`⚠ changelog/${plan.pkg}/v${plan.to}/log.md not found — commit release notes first`,
		);
	}

	// Guard 5: the tag must not already exist locally.
	if (runCapture(`git rev-parse -q --verify "refs/tags/${plan.tag}"`).trim()) {
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
console.log("─".repeat(60));

if (dryRun) {
	console.log("[dry-run] no writes, no git operations performed");
	process.exit(0);
}

for (const plan of plans) {
	plan.json.version = plan.to;
	writeJson(plan.manifestPath, plan.json);
}

run(`git add ${plans.map((p) => p.manifestPath).join(" ")}`);
run(`git commit -m "${commitMessage}"`);
for (const plan of plans) run(`git tag ${plan.tag}`);
run(`git push && git push --tags`);
console.log(
	`✓ Released ${plans.map((p) => p.tag).join(", ")}. CI will publish each tagged package.`,
);
