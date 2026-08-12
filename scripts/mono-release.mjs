#!/usr/bin/env node
// mono-release — lockstep release: bump ALL workspace packages to one shared
// version, commit "release: vX.Y.Z", tag it, and push. CI publishes only the
// packages that changed since the previous release commit
// (.github/workflows/publish.yml).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `mono-release — 锁步发版（bump + release 提交 + tag + push）

用法:
  bun run mono-release:patch   0.1.0 → 0.1.1（修 bug / 日常小改）
  bun run mono-release:minor   0.1.0 → 0.2.0（新功能）
  bun run mono-release:major   0.1.0 → 1.0.0（破坏性变更）
  bun run mono-release -- --help   显示本帮助

流程:
  1. 校验五个 manifest（根 + packages/*）版本一致
  2. 守卫: 工作区必须干净（未提交改动会随 release 一起被遗漏）
  3. 守卫: 自上一 tag 以来 packages/ 必须有实质变更（纯 changelog/docs 不发版）
  4. registry 前置守卫: 目标版本已在任一包存在则中止（先 mono-sync --sync）
  5. 写回版本 → commit "release: vX.Y.Z" → tag vX.Y.Z → push
  6. GitHub Actions 收到 tag 后按 diff 挑变更包，OIDC 发布

前置条件: git 远端已配置、工作区无未提交改动、changelog/vX.Y.Z/log.md 已提交
（缺失只告警不拦截）、四包 Trusted Publisher 已配置
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(HELP);
	process.exit(0);
}

const bump = args[0];
if (!["patch", "minor", "major"].includes(bump)) {
	console.error(
		`✗ invalid bump step: ${bump ?? "(none)"} (expects patch | minor | major)`,
	);
	console.error("  Run mono-release --help for usage.");
	process.exit(1);
}
// bun appends user args AFTER the script's own args, so an invocation like
// "bun run mono-release:patch -- --bogus" arrives as ["patch", "--bogus"].
// Reject extras: silently ignoring them released v0.1.1 by accident once.
const extras = args.slice(1).filter((a) => a !== "--help" && a !== "-h");
if (extras.length > 0) {
	console.error(`✗ unexpected argument(s): ${extras.join(", ")}`);
	console.error("  mono-release takes exactly one argument: patch | minor | major");
	process.exit(1);
}

const packages = [
	"pi-gadget",
	"pi-oc-go-luna-vision",
	"pi-shelld",
	"pi-switch-cwd",
];
const manifestPaths = [
	join(root, "package.json"),
	...packages.map((p) => join(root, "packages", p, "package.json")),
];

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
			{
				signal: AbortSignal.timeout(10000),
			},
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

const manifests = manifestPaths.map((p) => ({ path: p, json: readJson(p) }));
const versions = manifests.map((m) => m.json.version);
if (new Set(versions).size !== 1) {
	console.error(`Version mismatch across workspace: ${versions.join(", ")}`);
	console.error("  Run mono-sync --sync (or --set) first.");
	process.exit(1);
}

// Guard: a release commit only carries the five version bumps — anything else
// uncommitted (fixes, docs, CI changes) would silently ship without this
// release. This is exactly how two bogus releases escaped once.
const dirty = runCapture(`git status --porcelain`).trim();
if (dirty.length > 0) {
	console.error("✗ working tree is not clean — commit or stash first:");
	for (const line of dirty.split("\n").slice(0, 10)) console.error(`  ${line}`);
	process.exit(1);
}

// Guard: releasing without package changes advances the lockstep version but
// publishes nothing, so local drifts ahead of the registry and --sync refuses
// to downgrade. Changelog/docs/scripts changes alone don't warrant a release.
const prevTag = runCapture(`git describe --tags --abbrev=0 HEAD 2>/dev/null || true`).trim();
if (prevTag) {
	const changed = runCapture(`git diff --name-only ${prevTag}..HEAD -- packages/`).trim();
	if (changed.length === 0) {
		console.error(`✗ no package changes since ${prevTag} — nothing to publish`);
		console.error("  Changelog/docs/scripts changes alone don't warrant a release.");
		process.exit(1);
	}
}

const [major, minor, patch] = versions[0].split(".").map(Number);
const next =
	bump === "major"
		? `${major + 1}.0.0`
		: bump === "minor"
			? `${major}.${minor + 1}.0`
			: `${major}.${minor}.${patch + 1}`;

// Pre-flight: never bump onto a version that already exists on the registry.
// A hit means local is behind the registry baseline — sync first.
const occupied = [];
for (const p of packages) {
	const name = readJson(join(root, "packages", p, "package.json")).name;
	if (await alreadyPublished(name, next)) occupied.push(name);
}
if (occupied.length > 0) {
	console.error(`✗ v${next} already published for: ${occupied.join(", ")}`);
	console.error("  Local is behind the registry baseline. Run first:");
	console.error("    bun run mono-sync -- --sync  (preview: add --dry-run)");
	process.exit(1);
}

// Manual changelog discipline (see docs/git提交规范.md): the release notes
// are committed by hand BEFORE the release; missing ones only warn.
const changelogPath = join(root, "changelog", `v${next}`, "log.md");
if (!existsSync(changelogPath)) {
	console.warn(`⚠ changelog/${`v${next}`}/log.md not found — commit release notes first`);
}

for (const m of manifests) {
	m.json.version = next;
	writeJson(m.path, m.json);
}

run(`git add package.json packages/*/package.json`);
run(`git commit -m "release: v${next}"`);
run(`git tag v${next}`);
run(`git push && git push --tags`);
console.log(`✓ Released v${next}. CI will publish the changed packages.`);
