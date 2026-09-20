import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import imagegenExtension from "../pi-codex-imagegen.ts";
import shelldExtension, {
	SHELLD_SERVICE_CHANNEL,
} from "../../pi-shelld/src/index.ts";
import { getShell, listShells, stateDir } from "../../pi-shelld/src/shells.ts";

type Handler = (...args: any[]) => unknown;
type RegisteredTool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};
type ShellExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
};

class FakePi {
	readonly events = new EventEmitter();
	readonly tools: RegisteredTool[] = [];
	readonly handlers = new Map<string, Handler[]>();
	readonly messages: any[] = [];

	registerTool(tool: RegisteredTool): void {
		this.tools.push(tool);
	}

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerShortcut(): void {}
	registerCommand(): void {}

	sendMessage(message: any, options: any): void {
		this.messages.push({ message, options });
	}

	getTool(name: string): RegisteredTool {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`missing fake tool ${name}`);
		return tool;
	}

	async trigger(event: string, ctx: any): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler({}, ctx);
		}
	}
}

function makeContext(root: string): any {
	const statuses = new Map<string, string | undefined>();
	return {
		cwd: root,
		mode: "tui",
		statuses,
		ui: {
			setStatus(key: string, value?: string) {
				statuses.set(key, value);
			},
			notify() {},
		},
		sessionManager: {
			getSessionFile: () => join(root, "session.jsonl"),
		},
	};
}

function installImagegen(
	pi: FakePi,
	service?: FakeShelldService,
): RegisteredTool {
	if (service) {
		pi.events.on(SHELLD_SERVICE_CHANNEL, (request: any) => {
			request.provide(service);
		});
	}
	imagegenExtension(pi as any);
	return pi.getTool("pi-codex-imagegen");
}

async function executeImagegen(
	tool: RegisteredTool,
	params: { imagePrompt: string; outputPath: string },
	ctx: any,
): Promise<any> {
	return tool.execute("test-call", params, undefined, undefined, ctx);
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error(`condition did not settle within ${timeoutMs}ms`);
}

async function waitForMessage(
	pi: FakePi,
	service?: FakeShelldService,
): Promise<any> {
	if (service) await waitFor(() => service.closeCalls.length > 0);
	await waitFor(() => pi.messages.length > 0);
	return pi.messages.at(-1)?.message;
}

interface FakeRun {
	shellId: string;
	cwd: string;
	stagingPath: string;
	logFile: string;
	settled: Promise<ShellExit>;
	resolve(exit: ShellExit): void;
}

class FakeShelldService {
	readonly starts: FakeRun[] = [];
	readonly closeCalls: string[] = [];
	onStart?: (run: FakeRun) => Promise<void> | void;

	async start(options: {
		command: string;
		cwd: string;
		name?: string;
	}): Promise<{
		shellId: string;
		logFile: string;
		startedAt: number;
		settled: Promise<ShellExit>;
	}> {
		let resolveSettled!: (exit: ShellExit) => void;
		const settled = new Promise<ShellExit>((resolvePromise) => {
			resolveSettled = resolvePromise;
		});
		const shellId = `fake-shell-${this.starts.length + 1}`;
		const logFile = join(options.cwd, "fake-codex.log");
		writeFileSync(logFile, "fake shell log\n", "utf8");
		const run: FakeRun = {
			shellId,
			cwd: options.cwd,
			stagingPath: join(options.cwd, "result.png"),
			logFile,
			settled,
			resolve: resolveSettled,
		};
		this.starts.push(run);
		await this.onStart?.(run);
		return { shellId, logFile, startedAt: Date.now(), settled };
	}

	async close(shellId: string): Promise<void> {
		this.closeCalls.push(shellId);
	}
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function writeFakeCodex(binDir: string): void {
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	const executable = join(binDir, "codex");
	writeFileSync(
		executable,
		`#!/usr/bin/env bash\nset -euo pipefail\ncat > "$FAKE_CODEX_PROMPT_CAPTURE"\nprintf '%s' '${png}' | base64 --decode > result.png\n`,
		"utf8",
	);
	chmodSync(executable, 0o755);
}

test("fails without pi-shelld service before creating work", async () => {
	const root = mkdtempSync(join(tmpdir(), "imagegen-missing-service-"));
	const outputPath = join(root, "out", "image.png");
	const before = new Set(readdirSync(tmpdir()));
	const pi = new FakePi();
	const tool = installImagegen(pi);
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	);
	try {
		let failure: unknown;
		try {
			await executeImagegen(
				tool,
				{ imagePrompt: "draw a quiet blue circle", outputPath },
				makeContext(root),
			);
		} catch (error) {
			failure = error;
		}
		expect(String(failure)).toMatch(/service v1 is unavailable/);
		expect(manifest.dependencies?.["@yceachan/pi-shelld"]).toBe("^0.3.0");
		expect(existsSync(dirname(outputPath))).toBe(false);
		expect(
			readdirSync(tmpdir()).filter(
				(name) => name.startsWith("pi-codex-imagegen-") && !before.has(name),
			),
		).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discovers pi-shelld, stages result.png, delivers it, and cleans up", async () => {
	const root = mkdtempSync(join(tmpdir(), "imagegen-hermetic-e2e-"));
	const binDir = join(root, "bin");
	const capturePath = join(root, "captured-prompt.txt");
	const outputPath = join(root, "delivered.png");
	const imageIntent = "A loose ink sketch of a red fox under a crescent moon";
	mkdirSync(binDir, { recursive: true });
	writeFakeCodex(binDir);

	const previousPath = process.env.PATH;
	const previousCapture = process.env.FAKE_CODEX_PROMPT_CAPTURE;
	process.env.PATH = `${binDir}:${previousPath ?? ""}`;
	process.env.FAKE_CODEX_PROMPT_CAPTURE = capturePath;

	const pi = new FakePi();
	const ctx = makeContext(root);
	shelldExtension(pi as any);
	imagegenExtension(pi as any);
	let shellLog: string | undefined;
	let shellCwd: string | undefined;
	try {
		await pi.trigger("session_start", ctx);
		const result = await executeImagegen(
			pi.getTool("pi-codex-imagegen"),
			{ imagePrompt: imageIntent, outputPath },
			ctx,
		);
		const shellId = String(result.details.shellId);
		const shell = getShell(shellId);
		expect(shell).toBeDefined();
		shellLog = shell?.logFile;
		shellCwd = shell?.cwd;

		const message = await waitForMessage(pi);
		expect(message.details.status).toBe("completed");
		expect(readFileSync(outputPath).subarray(1, 4).toString()).toBe("PNG");
		const prompt = readFileSync(capturePath, "utf8");
		expect(prompt).toContain(imageIntent);
		expect(prompt).toContain("result.png");
		expect(prompt).not.toContain(outputPath);
		expect(result.details.jobId).toBeUndefined();
		expect(getShell(shellId)).toBeUndefined();
		expect(ctx.statuses.get("shelld")).toBeUndefined();
		expect(shellLog && existsSync(shellLog)).toBe(false);
		expect(shellCwd && existsSync(shellCwd)).toBe(false);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCapture === undefined)
			delete process.env.FAKE_CODEX_PROMPT_CAPTURE;
		else process.env.FAKE_CODEX_PROMPT_CAPTURE = previousCapture;
		await pi.trigger("session_shutdown", ctx);
		expect(listShells()).toEqual([]);
		expect(existsSync(stateDir())).toBe(false);
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails and cleans up when Codex exits non-zero or omits result.png", async () => {
	for (const scenario of ["non-zero", "missing-result"] as const) {
		const root = mkdtempSync(join(tmpdir(), `imagegen-${scenario}-`));
		const outputPath = join(root, "out", "image.png");
		const service = new FakeShelldService();
		service.onStart = (run) => {
			run.resolve({
				code: scenario === "non-zero" ? 1 : 0,
				signal: null,
			});
		};
		const pi = new FakePi();
		const tool = installImagegen(pi, service);
		try {
			const result = await executeImagegen(
				tool,
				{ imagePrompt: "draw a simple icon", outputPath },
				makeContext(root),
			);
			const message = await waitForMessage(pi, service);
			expect(message.details.status).toBe("failed");
			expect(service.closeCalls).toEqual([result.details.shellId]);
			expect(existsSync(outputPath)).toBe(false);
			expect(existsSync(service.starts[0].cwd)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});
