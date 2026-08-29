import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initialReleaseDecision } from "../lib.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function command(cwd, executable, args, env = {}) {
	const result = spawnSync(executable, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
}

function commandAsync(cwd, executable, args, env = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(executable, args, {
			cwd,
			env: { ...process.env, ...env },
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolveRun({ status, output }));
	});
}

function git(cwd, args) {
	const result = command(cwd, "git", args);
	assert.equal(result.status, 0, result.output);
	return result.output.trim();
}

function copyScripts(root, names) {
	mkdirSync(join(root, "scripts"), { recursive: true });
	for (const name of names) {
		cpSync(join(sourceRoot, "scripts", name), join(root, "scripts", name));
	}
}

function initRepo({ release = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "version-workflow-"));
	copyScripts(
		root,
		release ? ["lib.mjs", "mono-release.mjs"] : ["lib.mjs", "gcm.mjs"],
	);
	mkdirSync(join(root, "packages", "foo"), { recursive: true });
	writeFileSync(
		join(root, "packages", "foo", "package.json"),
		`${JSON.stringify({ name: "@yceachan/foo", version: "0.1.0", publishConfig: { access: "public" } }, null, 2)}\n`,
	);
	writeFileSync(
		join(root, "packages", "foo", "index.ts"),
		"export const value = 1;\n",
	);
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.email", "test@example.invalid"]);
	git(root, ["config", "user.name", "Workflow Test"]);

	if (release) {
		writeFileSync(join(root, "scripts", "sync-readme.mjs"), "process.exit(0);\n");
		mkdirSync(join(root, "changelog", "foo", "v0.1.0"), { recursive: true });
		writeFileSync(
			join(root, "changelog", "foo", "v0.1.0", "log.md"),
			"# foo v0.1.0\n\n## feat\n- initial package\n",
		);
		writeFileSync(
			join(root, "bun.lock"),
			'["packages/foo"]\n"version": "0.1.0"\n',
		);
	}
	git(root, [
		"add",
		"scripts",
		"packages",
		...(release ? ["changelog", "bun.lock"] : []),
	]);
	git(root, ["commit", "-m", "test fixture"]);
	return root;
}

async function registryServer(response) {
	const server = createServer((_request, reply) => {
		const value = typeof response === "function" ? response() : response;
		if (value === null) {
			reply.writeHead(404).end("not found");
			return;
		}
		reply.writeHead(200, { "content-type": "application/json" });
		reply.end(JSON.stringify({ versions: value }));
	});
	await new Promise((resolveListen) =>
		server.listen(0, "127.0.0.1", resolveListen),
	);
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolveClose) => server.close(resolveClose)),
	};
}

function makeFakeNpm() {
	const bin = mkdtempSync(join(tmpdir(), "version-workflow-bin-"));
	const npm = join(bin, "npm");
	writeFileSync(
		npm,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then echo workflow-test; exit 0; fi
case " $* " in
  *" --dry-run "*) echo "npm notice dry-run tarball"; exit 0 ;;
esac
if [ "$FAIL_PUBLISH" = "1" ]; then echo "publish rejected" >&2; exit 42; fi
echo "published"
`,
		{ mode: 0o755 },
	);
	return bin;
}

const baseDecision = {
	registryStatus: "unknown",
	registryVersion: null,
	manifestVersion: "0.1.0",
	localTag: "absent",
	remoteTag: "absent",
};

test("initial release state matrix is resumable and rejects ambiguous facts", () => {
	assert.deepEqual(initialReleaseDecision(baseDecision), {
		createTag: true,
		publish: true,
		push: true,
		done: false,
	});
	assert.equal(
		initialReleaseDecision({ ...baseDecision, localTag: "head" }).createTag,
		false,
	);
	assert.deepEqual(
		initialReleaseDecision({
			...baseDecision,
			registryStatus: "ok",
			registryVersion: "0.1.0",
			localTag: "head",
			remoteTag: "absent",
		}),
		{ createTag: false, publish: false, push: true, done: false },
	);
	assert.deepEqual(
		initialReleaseDecision({
			...baseDecision,
			registryStatus: "ok",
			registryVersion: "0.1.0",
			localTag: "head",
			remoteTag: "head",
		}),
		{ createTag: false, publish: false, push: false, done: true },
	);
	for (const state of [
		{ localTag: "other" },
		{ remoteTag: "other" },
		{ registryStatus: "unreachable" },
		{ registryStatus: "ok", registryVersion: "0.2.0" },
		{ registryStatus: "ok", registryVersion: "0.1.0", localTag: "absent" },
	]) {
		assert.match(
			initialReleaseDecision({ ...baseDecision, ...state }).error,
			/./,
		);
	}
});

test("gcm help, language-neutral subject, dirty isolation, and allow-dirty", () => {
	const root = initRepo();
	const help = command(root, "bun", ["scripts/gcm.mjs", "--help"]);
	assert.equal(help.status, 0);
	assert.match(help.output, /\.\/gcm -t/);
	assert.match(help.output, /\.\/gcm -c/);
	assert.match(help.output, /\.\/gcm --list/);
	assert.ok(help.output.indexOf("示例") < help.output.indexOf("参数"));
	assert.doesNotMatch(
		help.output,
		/chores 自动|release 禁止手写|推荐工作流|二级匹配/,
	);
	for (const line of help.output.split("\n"))
		assert.ok(line.length <= 100, line);
	const coloredHelp = command(root, "bun", ["scripts/gcm.mjs", "--help"], {
		FORCE_COLOR: "1",
	});
	assert.match(coloredHelp.output, /\u001B\[1;32m用法\u001B\[0m/);
	const coloredError = command(root, "bun", ["scripts/gcm.mjs", "--bad"], {
		FORCE_COLOR: "1",
	});
	assert.match(coloredError.output, /\u001B\[31m✗/);
	const plainHelp = command(root, "bun", ["scripts/gcm.mjs", "--help"], {
		FORCE_COLOR: "1",
		NO_COLOR: "1",
	});
	assert.doesNotMatch(plainHelp.output, /\u001B\[/);

	const printed = command(root, "bun", [
		"scripts/gcm.mjs",
		"-t",
		"fix",
		"-p",
		"skills",
		"-m",
		"修复提交隔离",
		"--print",
	]);
	assert.equal(printed.status, 0, printed.output);
	assert.equal(printed.output.trim(), "fix(skills): 修复提交隔离");
	assert.doesNotMatch(printed.output, /英文|临时使用/);

	writeFileSync(join(root, "staged.txt"), "staged\n");
	git(root, ["add", "staged.txt"]);
	writeFileSync(join(root, "untracked.txt"), "later\n");
	const blocked = command(root, "bun", [
		"scripts/gcm.mjs",
		"-t",
		"fix",
		"-m",
		"isolate work",
		"--dry",
	]);
	assert.notEqual(blocked.status, 0);
	assert.match(blocked.output, /git stash push -k -u/);
	assert.match(blocked.output, /--allow-dirty/);
	assert.match(blocked.output, /untracked\.txt/);

	const allowed = command(root, "bun", [
		"scripts/gcm.mjs",
		"-t",
		"fix",
		"-m",
		"isolate work",
		"--dry",
		"--allow-dirty",
	]);
	assert.equal(allowed.status, 0, allowed.output);
	assert.match(allowed.output, /staged\.txt/);
	assert.match(allowed.output, /保留在工作区/);
});

test("gcm blocks unmerged entries before dirty guidance and scopes allow-dirty to commits", () => {
	const root = initRepo();
	git(root, ["checkout", "-b", "side"]);
	writeFileSync(
		join(root, "packages", "foo", "index.ts"),
		"export const value = 2;\n",
	);
	git(root, ["add", "packages/foo/index.ts"]);
	git(root, ["commit", "-m", "side"]);
	git(root, ["checkout", "main"]);
	writeFileSync(
		join(root, "packages", "foo", "index.ts"),
		"export const value = 3;\n",
	);
	git(root, ["add", "packages/foo/index.ts"]);
	git(root, ["commit", "-m", "main"]);
	const merge = command(root, "git", ["merge", "side"]);
	assert.notEqual(merge.status, 0);

	const conflict = command(root, "bun", [
		"scripts/gcm.mjs",
		"-t",
		"fix",
		"-m",
		"resolve conflict",
		"--dry",
	]);
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.output, /unmerged: packages\/foo\/index\.ts/);
	assert.doesNotMatch(conflict.output, /stash push/);

	for (const args of [
		["--list", "--allow-dirty"],
		["-c", "-p", "foo", "--patch", "--allow-dirty"],
	]) {
		const invalid = command(root, "bun", ["scripts/gcm.mjs", ...args]);
		assert.notEqual(invalid.status, 0);
	}
});

test("gbump help is compact and rejects conflicting release modes", () => {
	const help = command(sourceRoot, "bun", ["scripts/gbump.mjs", "--help"]);
	assert.equal(help.status, 0, help.output);
	assert.ok(help.output.indexOf("示例") < help.output.indexOf("参数"));
	assert.doesNotMatch(help.output, /薄壳|完整守卫|二级匹配|mono-release/);
	for (const line of help.output.split("\n"))
		assert.ok(line.length <= 100, line);
	const coloredHelp = command(
		sourceRoot,
		"bun",
		["scripts/gbump.mjs", "--help"],
		{ FORCE_COLOR: "1" },
	);
	assert.match(coloredHelp.output, /\u001B\[1;32m用法\u001B\[0m/);
	const coloredError = command(
		sourceRoot,
		"bun",
		["scripts/gbump.mjs", "--bad"],
		{ FORCE_COLOR: "1" },
	);
	assert.match(coloredError.output, /\u001B\[31m✗/);

	const result = command(sourceRoot, "bun", [
		"scripts/gbump.mjs",
		"-p",
		"foo",
		"--initial",
		"--patch",
	]);
	assert.notEqual(result.status, 0);
	assert.match(result.output, /conflicting version flags/);
});

test("gcm changelog permits manifest version only for an unpublished package", async () => {
	const root = initRepo();
	const unknown = await registryServer(null);
	try {
		const created = await commandAsync(
			root,
			"bun",
			["scripts/gcm.mjs", "-c", "-p", "foo", "--set-ver", "0.1.0"],
			{ NPM_CONFIG_REGISTRY: unknown.url },
		);
		assert.equal(created.status, 0, created.output);
		assert.match(created.output, /vim changelog\/foo\/v0\.1\.0\/log\.md/);
		assert.match(created.output, /\.\/gbump -p foo --initial --dry-run/);
		assert.match(
			readFileSync(join(root, "changelog", "foo", "v0.1.0", "log.md"), "utf8"),
			/# foo v0\.1\.0/,
		);
		const existing = await commandAsync(
			root,
			"bun",
			["scripts/gcm.mjs", "-c", "-p", "foo", "--set-ver", "0.1.0"],
			{ NPM_CONFIG_REGISTRY: unknown.url },
		);
		assert.notEqual(existing.status, 0);
		assert.match(existing.output, /vim changelog\/foo\/v0\.1\.0\/log\.md/);
	} finally {
		await unknown.close();
	}

	const otherRoot = initRepo();
	const published = await registryServer({ "0.1.0": {} });
	try {
		const rejected = await commandAsync(
			otherRoot,
			"bun",
			["scripts/gcm.mjs", "-c", "-p", "foo", "--set-ver", "0.1.0"],
			{ NPM_CONFIG_REGISTRY: published.url },
		);
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.output, /registry 基线 0\.1\.0/);
	} finally {
		await published.close();
	}
});

test("initial CLI dry-run, non-TTY confirmation, failure recovery, and exact tag push", async () => {
	const root = initRepo({ release: true });
	const remote = mkdtempSync(join(tmpdir(), "version-workflow-remote-"));
	git(remote, ["init", "--bare"]);
	git(root, ["remote", "add", "origin", remote]);
	git(root, ["push", "-u", "origin", "main"]);
	const registry = await registryServer(null);
	const fakeBin = makeFakeNpm();
	const npmLog = join(tmpdir(), `version-workflow-npm-${process.pid}.log`);
	const env = {
		NPM_CONFIG_REGISTRY: registry.url,
		PATH: `${fakeBin}:${process.env.PATH}`,
		NPM_LOG: npmLog,
	};
	try {
		const regular = await commandAsync(
			root,
			"bun",
			["scripts/mono-release.mjs", "foo", "patch", "--dry-run"],
			env,
		);
		assert.notEqual(regular.status, 0);
		assert.match(regular.output, /\.\/gbump -p foo --initial --dry-run/);

		const dry = await commandAsync(
			root,
			"bun",
			["scripts/mono-release.mjs", "foo", "--initial", "--dry-run"],
			env,
		);
		assert.equal(dry.status, 0, dry.output);
		assert.match(dry.output, /no tag, publish, push, or registry write/);
		assert.equal(command(root, "git", ["tag", "--list"]).output.trim(), "");

		const noConfirmation = await commandAsync(
			root,
			"bun",
			["scripts/mono-release.mjs", "foo", "--initial"],
			env,
		);
		assert.notEqual(noConfirmation.status, 0);
		assert.match(noConfirmation.output, /requires --yes/);
		assert.equal(command(root, "git", ["tag", "--list"]).output.trim(), "");

		const publishFailure = await commandAsync(
			root,
			"bun",
			["scripts/mono-release.mjs", "foo", "--initial", "--yes"],
			{ ...env, FAIL_PUBLISH: "1" },
		);
		assert.notEqual(publishFailure.status, 0);
		assert.match(publishFailure.output, /local tag foo@0\.1\.0 remains at HEAD/);
		assert.equal(
			command(root, "git", ["tag", "--list"]).output.trim(),
			"foo@0.1.0",
		);
		assert.equal(git(remote, ["tag", "--list"]), "");

		const resumed = await commandAsync(
			root,
			"bun",
			["scripts/mono-release.mjs", "foo", "--initial", "--yes"],
			env,
		);
		assert.equal(resumed.status, 0, resumed.output);
		assert.equal(git(remote, ["tag", "--list"]), "foo@0.1.0");
		const log = readFileSync(npmLog, "utf8");
		assert.match(log, /whoami/);
		assert.match(log, /publish --access public --dry-run/);
		assert.match(log, /publish --access public\n/);
	} finally {
		await registry.close();
	}
});
