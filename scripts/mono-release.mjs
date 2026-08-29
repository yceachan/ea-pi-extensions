#!/usr/bin/env bun
// mono-release — regular per-package releases and explicit first publishes.
// Regular releases bump manifests, sync bun.lock, commit, tag, and push. Initial
// releases keep the manifest version unchanged and use local npm credentials to
// seed the registry before pushing the exact release tag.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ask,
	compareVersions,
	gitDirty,
	initialReleaseDecision,
	isValidVersion,
	readJson,
	registryBaseline,
	syncLockfileWorkspaceVersions,
	writeJson,
} from "./lib.mjs";

const HELP = `mono-release — 逐包发版仪式

用法:
  bun scripts/mono-release.mjs <pkg> patch|minor|major [<pkg> <bump> ...]
  bun scripts/mono-release.mjs <pkg> --set-ver X.Y.Z [--dry-run]
  bun scripts/mono-release.mjs <pkg> --initial [--dry-run] [--yes]

模式:
  regular  从 registry 基线推进版本，写 manifest/bun.lock、创建 release commit 与 tag
  initial  使用 manifest 当前版本首次发布；不改文件、不创建 release commit

initial 守卫与执行:
  clean tree → README 同步 → changelog 有实质条目 → registry/tag 状态可判定 →
  npm whoami → npm publish --access public --dry-run → 确认完整 tag →
  tag → npm publish → git push → git push origin <exact-tag>
  非 TTY 实发必须给 --yes；--dry-run 永不创建 tag、publish 或 push。
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const colorsAllowed = process.env.NO_COLOR === undefined;
const forceColor = process.env.FORCE_COLOR === "1";
const useErrorColor = colorsAllowed && (process.stderr.isTTY || forceColor);
const errorText = (text) =>
	useErrorColor ? `\u001B[31m${text}\u001B[0m` : text;
const warningText = (text) =>
	useErrorColor ? `\u001B[33m${text}\u001B[0m` : text;
const printError = (text) => process.stderr.write(`${errorText(text)}\n`);
const printWarning = (text) => process.stderr.write(`${warningText(text)}\n`);

const args = process.argv.slice(2);
const helpOnly =
	args.length > 0 && args.every((arg) => arg === "--help" || arg === "-h");
if (args.length === 0 || helpOnly) {
	console.log(HELP);
	process.exit(args.length === 0 ? 1 : 0);
}

function fail(message) {
	printError(`✗ ${message}`);
	process.exit(1);
}

function capture(command, commandArgs, cwd = root) {
	try {
		return execFileSync(command, commandArgs, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const detail = error.stderr?.toString().trim();
		fail(
			`${command} ${commandArgs.join(" ")} failed${detail ? `: ${detail}` : ""}`,
		);
	}
}

function captureOptional(command, commandArgs, cwd = root) {
	try {
		return execFileSync(command, commandArgs, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

function run(command, commandArgs, cwd = root) {
	const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
	if (result.error) fail(`${command} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} failed`);
}

const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes") || args.includes("-y");
const items = args.filter((arg) => !["--dry-run", "--yes", "-y"].includes(arg));
const specs = [];
for (let index = 0; index < items.length; ) {
	const pkg = items[index];
	if (pkg.startsWith("--")) fail(`unknown argument: ${pkg}`);
	const mode = items[index + 1];
	if (!mode) fail(`missing release mode after ${pkg}`);
	if (mode === "--set-ver") {
		const version = items[index + 2];
		if (!version || version.startsWith("--")) {
			fail("--set-ver requires a version: <pkg> --set-ver X.Y.Z");
		}
		specs.push({ pkg, mode: "set-ver", setVer: version });
		index += 3;
	} else if (mode === "--initial") {
		specs.push({ pkg, mode: "initial", setVer: null });
		index += 2;
	} else {
		specs.push({ pkg, mode, setVer: null });
		index += 2;
	}
}

const initialSpecs = specs.filter((spec) => spec.mode === "initial");
if (
	initialSpecs.length > 0 &&
	(specs.length !== 1 || initialSpecs.length !== 1)
) {
	fail("--initial is exclusive and releases exactly one package");
}
if (yes && initialSpecs.length === 0) {
	console.warn("⚠ --yes has no release-confirmation effect outside --initial");
}

const bumps = new Set(["patch", "minor", "major"]);
const plans = [];
const seen = new Set();
for (const spec of specs) {
	if (seen.has(spec.pkg)) fail(`package listed twice: ${spec.pkg}`);
	seen.add(spec.pkg);
	const manifestPath = join(root, "packages", spec.pkg, "package.json");
	if (!existsSync(manifestPath)) fail(`no such package: ${spec.pkg}`);
	const json = readJson(manifestPath);
	if (!isValidVersion(json.version)) {
		fail(`invalid current version for ${spec.pkg}: ${json.version}`);
	}

	let to = json.version;
	if (spec.mode === "set-ver") {
		if (!isValidVersion(spec.setVer)) {
			fail(`invalid version for ${spec.pkg}: ${spec.setVer} (expects X.Y.Z)`);
		}
		if (compareVersions(spec.setVer, json.version) <= 0) {
			fail(`target ${spec.setVer} is not greater than current ${json.version}`);
		}
		to = spec.setVer;
	} else if (spec.mode !== "initial") {
		if (!bumps.has(spec.mode)) {
			fail(
				`invalid bump for ${spec.pkg}: ${spec.mode} (expects patch|minor|major)`,
			);
		}
		const [major, minor, patch] = json.version.split(".").map(Number);
		if (spec.mode === "major") to = `${major + 1}.0.0`;
		else if (spec.mode === "minor") to = `${major}.${minor + 1}.0`;
		else to = `${major}.${minor}.${patch + 1}`;
	}

	plans.push({
		pkg: spec.pkg,
		mode: spec.mode,
		manifestPath,
		packageDir: dirname(manifestPath),
		json,
		from: json.version,
		to,
		tag: `${spec.pkg}@${to}`,
		initial: spec.mode === "initial",
		writeManifest: spec.mode !== "initial",
		writeLock: spec.mode !== "initial",
		releaseCommit: spec.mode !== "initial",
	});
}

const dirty = gitDirty(root);
if (dirty.length > 0) {
	printError(
		[
			"✗ working tree is not clean — commit or stash first:",
			...dirty.split("\n").map((line) => `  ${line}`),
		].join("\n"),
	);
	process.exit(1);
}

try {
	execFileSync(process.execPath, ["scripts/sync-readme.mjs", "--check"], {
		cwd: root,
		stdio: "inherit",
	});
} catch {
	fail("README 包清单过期——先运行 ./sync-readme 重建后重试发版");
}

function requireChangelog(plan) {
	const notes = join(root, "changelog", plan.pkg, `v${plan.to}`, "log.md");
	const modeHint =
		plan.mode === "set-ver" ? `--set-ver ${plan.to}` : `--${plan.mode}`;
	if (!existsSync(notes)) {
		fail(
			`changelog 缺失: ${notes}\n  先创建骨架: ./gcm -c -p ${plan.pkg} ${modeHint}`,
		);
	}
	const hasEntry = readFileSync(notes, "utf8")
		.split("\n")
		.some((line) => /^\s*-\s+\S/.test(line) && !line.includes("<!--"));
	if (!hasEntry) fail(`changelog 为空（骨架不含实质 "- " 条目）: ${notes}`);
	return notes;
}

function localTagState(tag, head) {
	const oid = captureOptional("git", [
		"rev-parse",
		"-q",
		"--verify",
		`refs/tags/${tag}^{commit}`,
	]);
	if (oid === null) return "absent";
	return oid === head ? "head" : "other";
}

function remoteTagState(tag, head) {
	const result = spawnSync(
		"git",
		[
			"ls-remote",
			"--tags",
			"--exit-code",
			"origin",
			`refs/tags/${tag}`,
			`refs/tags/${tag}^{}`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	if (result.status === 2) return "absent";
	if (result.status !== 0) {
		fail(
			`cannot determine remote tag ${tag}: ${result.stderr?.trim() || "git ls-remote failed"}`,
		);
	}
	const rows = result.stdout.trim().split("\n").filter(Boolean);
	const peeled = rows.find((row) => row.endsWith(`refs/tags/${tag}^{}`));
	const oid = (peeled ?? rows[0]).split(/\s+/)[0];
	return oid === head ? "head" : "other";
}

async function runInitial(plan) {
	const notes = requireChangelog(plan);
	const registry = await registryBaseline(`@yceachan/${plan.pkg}`);
	const head = capture("git", ["rev-parse", "HEAD"]);
	const localTag = localTagState(plan.tag, head);
	const remoteTag = remoteTagState(plan.tag, head);
	const decision = initialReleaseDecision({
		registryStatus: registry.status,
		registryVersion: registry.max,
		manifestVersion: plan.to,
		localTag,
		remoteTag,
	});
	if (decision.error) {
		fail(
			`${decision.error}\n  facts: registry=${registry.status}${registry.max ? `:${registry.max}` : ""}, local-tag=${localTag}, remote-tag=${remoteTag}, HEAD=${head}`,
		);
	}

	console.log("─".repeat(60));
	console.log(`  package: @yceachan/${plan.pkg}`);
	console.log(
		`  version: ${plan.from} → ${plan.to} (initial; manifest unchanged)`,
	);
	console.log(`  HEAD: ${head}`);
	console.log(`  tag: ${plan.tag} (local=${localTag}, remote=${remoteTag})`);
	console.log(`  changelog: ${notes}`);
	console.log(
		`  action: ${decision.done ? "already complete" : [decision.createTag && "tag", decision.publish && "publish", decision.push && "push"].filter(Boolean).join(" → ")}`,
	);
	console.log("─".repeat(60));

	const whoami = spawnSync("npm", ["whoami"], {
		cwd: plan.packageDir,
		stdio: "inherit",
	});
	if (whoami.status !== 0) {
		fail(
			"npm authentication failed before any tag write. Run npm login, then npm whoami, and retry.",
		);
	}

	console.log("→ npm publish --access public --dry-run");
	const packCheck = spawnSync(
		"npm",
		["publish", "--access", "public", "--dry-run"],
		{ cwd: plan.packageDir, stdio: "inherit" },
	);
	if (packCheck.status !== 0) {
		fail("npm publish dry-run failed; no tag, publish, or push was performed");
	}

	if (dryRun) {
		console.log(
			"[dry-run] guards and npm tarball check passed; no tag, publish, push, or registry write",
		);
		return;
	}
	if (decision.done) {
		console.log(
			`✓ ${plan.tag} is already published and points to HEAD locally and remotely`,
		);
		return;
	}

	if (!(process.stdin.isTTY && process.stdout.isTTY)) {
		if (!yes) {
			fail(
				`non-TTY initial publish requires --yes. Review --dry-run, then retry: ./gbump -p ${plan.pkg} --initial --yes`,
			);
		}
	} else {
		const answer = await ask(`输入完整 tag ${plan.tag} 以确认首次发布: `);
		if (answer !== plan.tag) fail("已取消；未创建 tag、publish 或 push");
	}

	if (decision.createTag) run("git", ["tag", plan.tag]);
	if (decision.publish) {
		const publish = spawnSync("npm", ["publish", "--access", "public"], {
			cwd: plan.packageDir,
			stdio: "inherit",
		});
		if (publish.status !== 0) {
			fail(
				`npm publish failed; local tag ${plan.tag} remains at HEAD and nothing was pushed. Fix npm authentication/2FA/metadata, then retry: ./gbump -p ${plan.pkg} --initial`,
			);
		}
	}
	if (decision.push) {
		const branchPush = spawnSync("git", ["push"], {
			cwd: root,
			stdio: "inherit",
		});
		if (branchPush.status !== 0) {
			fail(
				`branch push failed. Retry the same command; a published version will skip npm publish: ./gbump -p ${plan.pkg} --initial`,
			);
		}
		const tagPush = spawnSync("git", ["push", "origin", plan.tag], {
			cwd: root,
			stdio: "inherit",
		});
		if (tagPush.status !== 0) {
			fail(
				`tag push failed. Retry the same command: ./gbump -p ${plan.pkg} --initial`,
			);
		}
	}
	console.log(
		`✓ Initial release complete: ${plan.tag}. Tag CI may now create the Release page.`,
	);
}

async function runRegular(releasePlans) {
	let failed = false;
	for (const plan of releasePlans) {
		const registry = await registryBaseline(`@yceachan/${plan.pkg}`);
		if (registry.status === "unreachable") {
			printError(
				`✗ registry unreachable for @yceachan/${plan.pkg}; cannot establish a release baseline`,
			);
			failed = true;
		} else if (registry.status === "unknown") {
			printError(
				`✗ @yceachan/${plan.pkg} has no registry baseline; regular bump is not an initial publish\n  ./gbump -p ${plan.pkg} --initial --dry-run`,
			);
			failed = true;
		} else if (compareVersions(plan.from, registry.max) < 0) {
			printError(
				`✗ ${plan.pkg} local ${plan.from} is behind registry ${registry.max}\n  bun run version:sync -- --dry-run`,
			);
			failed = true;
		} else if (compareVersions(plan.from, registry.max) > 0) {
			printError(
				`✗ ${plan.pkg} local ${plan.from} is ahead of registry ${registry.max}; finish or repair that release first`,
			);
			failed = true;
		}

		const lastTag = captureOptional("git", [
			"describe",
			"--tags",
			"--match",
			`${plan.pkg}@*`,
			"--abbrev=0",
			"HEAD",
		]);
		if (lastTag) {
			const changed = capture("git", [
				"diff",
				"--name-only",
				`${lastTag}..HEAD`,
				"--",
				`packages/${plan.pkg}/`,
			]);
			if (!changed) {
				printError(
					`✗ packages/${plan.pkg}/ unchanged since ${lastTag} — nothing to publish`,
				);
				failed = true;
			}
		} else {
			printWarning(
				`⚠ ${plan.pkg} has no prior package tag — skipping changed-since guard`,
			);
		}

		try {
			requireChangelog(plan);
		} catch {
			failed = true;
		}
		if (
			localTagState(plan.tag, capture("git", ["rev-parse", "HEAD"])) !== "absent"
		) {
			printError(`✗ local tag already exists: ${plan.tag}`);
			failed = true;
		}
	}
	if (failed) process.exit(1);

	console.log("─".repeat(60));
	for (const plan of releasePlans) {
		console.log(
			`  @yceachan/${plan.pkg}  ${plan.from} → ${plan.to}  (${plan.mode})  tag ${plan.tag}`,
		);
	}
	const commitMessage = `release: ${releasePlans.map((plan) => plan.tag).join(", ")}`;
	console.log(`  commit: ${commitMessage}`);
	console.log(
		`  bun.lock: sync ${releasePlans.map((plan) => plan.pkg).join(", ")}`,
	);
	console.log("─".repeat(60));
	if (dryRun) {
		console.log("[dry-run] no writes or git operations performed");
		return;
	}

	for (const plan of releasePlans) {
		plan.json.version = plan.to;
		writeJson(plan.manifestPath, plan.json);
	}
	syncLockfileWorkspaceVersions(
		join(root, "bun.lock"),
		Object.fromEntries(releasePlans.map((plan) => [plan.pkg, plan.to])),
	);
	run("git", [
		"add",
		...releasePlans.map((plan) => plan.manifestPath),
		"bun.lock",
	]);
	run("git", ["commit", "-m", commitMessage]);
	for (const plan of releasePlans) run("git", ["tag", plan.tag]);
	run("git", ["push"]);
	for (const plan of releasePlans) run("git", ["push", "origin", plan.tag]);
	console.log(
		`✓ Released ${releasePlans.map((plan) => plan.tag).join(", ")}. CI will publish each tag.`,
	);
}

if (plans[0].initial) await runInitial(plans[0]);
else await runRegular(plans);
