// lib.mjs — shared utilities for the release scripts.
//
// One registry query implementation, one semver comparison, one JSON/read-write
// helper: gcm/gbump/mono-release/mono-tagcheck previously each carried its own
// copy of these, so a fix had to be applied four times and a single release
// flow queried the npm registry three times.
//
// The registry helpers distinguish three states so callers can keep their
// distinct warnings without re-implementing the fetch:
//   status "ok"          — package exists and has valid X.Y.Z versions
//   status "unknown"     — 404, or exists with no valid versions (never seeded)
//   status "unreachable" — network error / timeout / non-404 HTTP failure

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REGISTRY_TIMEOUT_MS = 10000;

export function isValidVersion(v) {
	return /^\d+\.\d+\.\d+$/.test(v);
}

export function compareVersions(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`✗ cannot read ${path}: ${err.message}`);
		process.exit(1);
	}
}

export function writeJson(path, value) {
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

// Surgical sync of bun.lock's workspace version fields for the given
// { pkg -> version } entries. bun.lock (lockfileVersion 1) records each
// workspace member's version; a release bump must follow it into the lock
// WITHOUT a full `bun install`, which could re-resolve "latest"
// devDependencies and drag unrelated changes into the release commit.
// The edit is exactly the one-line change a plain bun install would make
// (verified: bun install produces zero further diff after this runs).
export function syncLockfileWorkspaceVersions(lockPath, entries) {
	const lines = readFileSync(lockPath, "utf8").split("\n");
	let pending = Object.keys(entries).length;
	for (let i = 0; i < lines.length && pending > 0; i++) {
		const m = lines[i].match(/^\s*"packages\/([a-z0-9-]+)":\s*\{/);
		if (!m || !(m[1] in entries)) continue;
		const versionIdx = lines
			.slice(i + 1, i + 4)
			.findIndex((l) => l.includes('"version"'));
		if (versionIdx === -1) continue;
		lines[i + 1 + versionIdx] = lines[i + 1 + versionIdx].replace(
			/(\s*"version":\s*)"[^"]*"/,
			`$1"${entries[m[1]]}"`,
		);
		pending--;
	}
	if (pending > 0) {
		console.error(
			`✗ bun.lock sync incomplete (${pending} workspace version field(s) not found)`,
		);
		process.exit(1);
	}
	writeFileSync(lockPath, lines.join("\n"));
}

// Raw registry document with reachability info, or null only on hard failure.
async function fetchRegistry(name) {
	try {
		const res = await fetch(
			`https://registry.npmjs.org/${name.replace("/", "%2F")}`,
			{ signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) },
		);
		if (res.status === 404) return { kind: "unknown" };
		if (!res.ok) return { kind: "unreachable" };
		return { kind: "ok", doc: await res.json() };
	} catch {
		return { kind: "unreachable" };
	}
}

// Highest published X.Y.Z version: { status: "ok"|"unknown"|"unreachable", max }.
export async function registryBaseline(name) {
	const res = await fetchRegistry(name);
	if (res.kind !== "ok") return { status: res.kind, max: null };
	const versions = Object.keys(res.doc.versions ?? {}).filter(isValidVersion);
	if (versions.length === 0) return { status: "unknown", max: null };
	return {
		status: "ok",
		max: versions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b)),
	};
}

// { published, unreachable }: published=false when the registry is unreachable
// too, so callers can warn on unreachable but stay silent on a 404.
export async function isPublished(name, version) {
	const res = await fetchRegistry(name);
	if (res.kind !== "ok") return { published: false, unreachable: res.kind === "unreachable" };
	return {
		published: Object.keys(res.doc.versions ?? {}).includes(version),
		unreachable: false,
	};
}

// Read-only git helpers (the release scripts must never git-write via these).
export function runCapture(cmd, cwd) {
	try {
		return execSync(cmd, { cwd, encoding: "utf8" });
	} catch {
		return "";
	}
}

export function gitDirty(cwd) {
	return runCapture("git status --porcelain", cwd).trim();
}
