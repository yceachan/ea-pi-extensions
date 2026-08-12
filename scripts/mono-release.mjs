#!/usr/bin/env node
// Lockstep release: bump ALL workspace packages to one shared version,
// commit "Release vX.Y.Z", tag it, and push. CI publishes only the packages
// that changed since the previous tag (see .github/workflows/publish.yml).
//
// Usage: bun run release:patch | release:minor | release:major

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
	console.error("Usage: node scripts/release.mjs <patch|minor|major>");
	process.exit(1);
}

const packages = ["pi-gadget", "pi-oc-go-luna-vision", "pi-shelld", "pi-switch-cwd"];
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

const manifests = manifestPaths.map((p) => ({ path: p, json: readJson(p) }));
const versions = manifests.map((m) => m.json.version);
if (new Set(versions).size !== 1) {
	console.error(`Version mismatch across workspace: ${versions.join(", ")}`);
	process.exit(1);
}

const [major, minor, patch] = versions[0].split(".").map(Number);
const next =
	bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;

for (const m of manifests) {
	m.json.version = next;
	writeJson(m.path, m.json);
}

run(`git add package.json packages/*/package.json`);
run(`git commit -m "Release v${next}"`);
run(`git tag v${next}`);
run(`git push && git push --tags`);
console.log(`✓ Released v${next}. CI will publish the changed packages.`);
