import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants, existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	lstat,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";

const TOOL_NAME = "pi-codex-imagegen";
const SHELLD_SERVICE_CHANNEL = "pi-shelld:service:v1";
const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

interface CodexImagegenRequest {
	imagePrompt: string;
	outputPath: string;
}

interface ShelldStartResult {
	shellId: string;
	logFile: string;
	startedAt: number;
	settled: Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		error?: string;
	}>;
}

interface ShelldServiceV1 {
	start(options: {
		command: string;
		cwd: string;
		name?: string;
	}): Promise<ShelldStartResult>;
	close(shellId: string): Promise<void>;
}

interface BackgroundJob {
	controller: AbortController;
	completion: Promise<void>;
}

interface LaunchedCodexShell extends ShelldStartResult {
	workingDirectory: string;
	stagingPath: string;
}

interface FinishJobOptions {
	request: CodexImagegenRequest;
	service: ShelldServiceV1;
	launched: LaunchedCodexShell;
	controller: AbortController;
}

type JobMessageDetails =
	| { path: string; shellId: string; elapsedMs: number }
	| { error: string; shellId: string; elapsedMs: number };

function resolveShelldService(pi: ExtensionAPI): ShelldServiceV1 {
	let service: ShelldServiceV1 | undefined;
	pi.events.emit(SHELLD_SERVICE_CHANNEL, {
		provide(candidate: ShelldServiceV1) {
			service ??= candidate;
		},
	});
	if (!service) {
		throw new Error(
			`${TOOL_NAME}: pi-shelld service v1 is unavailable. Install or load @yceachan/pi-shelld as a separate Pi extension, then reload.`,
		);
	}
	return service;
}

function buildCodexPrompt(imagePrompt: string): string {
	return [
		"Create the requested image with your built-in image generation capability.",
		"Image intent, content, and style:",
		imagePrompt,
		"Save the final PNG as result.png in the current working directory.",
	].join("\n");
}

function resolveOutputPath(value: string, cwd: string): string {
	const raw = value.trim().replace(/^@/, "");
	if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
	return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

async function deliverStagedImage(
	stagingPath: string,
	outputPath: string,
): Promise<void> {
	const metadata = await lstat(stagingPath);
	if (!metadata.isFile()) {
		throw new Error("Codex did not create a regular result.png file");
	}
	await copyFile(stagingPath, outputPath, constants.COPYFILE_EXCL);
	try {
		await unlink(stagingPath);
	} catch (error) {
		await rm(outputPath, { force: true });
		throw error;
	}
}

function diagnosticTail(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_DIAGNOSTIC_CHARS) return trimmed;
	return `…${trimmed.slice(-MAX_DIAGNOSTIC_CHARS)}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function waitForCodex(
	settled: ShelldStartResult["settled"],
	signal: AbortSignal,
): Promise<Awaited<ShelldStartResult["settled"]>> {
	return new Promise((resolvePromise, rejectPromise) => {
		let done = false;
		let timeout: NodeJS.Timeout;
		const cleanup = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
		};
		const reject = (error: Error) => {
			if (done) return;
			done = true;
			cleanup();
			rejectPromise(error);
		};
		const resolveExit = (exit: Awaited<ShelldStartResult["settled"]>) => {
			if (done) return;
			done = true;
			cleanup();
			resolvePromise(exit);
		};
		const onAbort = () => reject(new Error("Codex image generation cancelled"));

		timeout = setTimeout(
			() => reject(new Error("Codex image generation timed out after 10 minutes")),
			CODEX_TIMEOUT_MS,
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		settled.then(resolveExit, reject);
	});
}

// pi-lens-ignore: high-fan-out, high-complexity
export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, BackgroundJob>();
	const reservedOutputPaths = new Set<string>();
	let shuttingDown = false;

	function postJobMessage(
		status: "completed" | "failed",
		text: string,
		details: JobMessageDetails,
	): void {
		if (shuttingDown) return;
		try {
			pi.sendMessage(
				{
					customType: TOOL_NAME,
					content: `${text}\n\nThe background job has settled. Deliver this result to the user now.`,
					display: true,
					details: { status, ...details },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// The session may have been replaced while the shell was settling.
		}
	}

	async function launchCodexShell(
		request: CodexImagegenRequest,
		service: ShelldServiceV1,
	): Promise<LaunchedCodexShell> {
		const workingDirectory = await mkdtemp(join(tmpdir(), `${TOOL_NAME}-`));
		try {
			await mkdir(dirname(request.outputPath), { recursive: true });
			if (existsSync(request.outputPath)) {
				throw new Error(`Output path already exists: ${request.outputPath}`);
			}

			const promptPath = join(workingDirectory, "prompt.txt");
			const stagingPath = join(workingDirectory, "result.png");
			await writeFile(promptPath, buildCodexPrompt(request.imagePrompt), "utf8");
			const codexArgs = [
				"codex",
				"exec",
				"--ephemeral",
				"--skip-git-repo-check",
				"--sandbox",
				"workspace-write",
				"--color",
				"never",
				"--enable",
				"image_generation",
				"-C",
				workingDirectory,
				"-",
			];
			const command = `${codexArgs.map(shellQuote).join(" ")} < ${shellQuote(promptPath)}`;
			const started = await service.start({
				command,
				cwd: workingDirectory,
				name: `imagegen:${basename(request.outputPath)}`,
			});
			return { ...started, workingDirectory, stagingPath };
		} catch (error) {
			await rm(workingDirectory, { recursive: true, force: true });
			throw error;
		}
	}

	async function finishJob({
		request,
		service,
		launched,
		controller,
	}: FinishJobOptions): Promise<void> {
		let failure: Error | string | undefined;
		try {
			const exit = await waitForCodex(launched.settled, controller.signal);
			if (exit.error) throw new Error(`Codex process error: ${exit.error}`);
			if (exit.code !== 0) {
				throw new Error(
					`Codex CLI exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}`,
				);
			}
			try {
				await deliverStagedImage(launched.stagingPath, request.outputPath);
			} finally {
				await rm(launched.stagingPath, { force: true });
			}
		} catch (error) {
			failure = error instanceof Error ? error : String(error);
		}

		if (failure) {
			try {
				const log = await readFile(launched.logFile, "utf8");
				failure = `${String(failure)}\n${diagnosticTail(log)}`;
			} catch {
				// The primary error is enough when no log is available.
			}
		}

		try {
			await service.close(launched.shellId);
		} catch (error) {
			failure ??= error instanceof Error ? error : String(error);
		}
		await rm(launched.workingDirectory, { recursive: true, force: true });

		if (shuttingDown) return;
		const elapsedMs = Date.now() - launched.startedAt;
		if (failure) {
			const diagnostic = diagnosticTail(String(failure));
			postJobMessage(
				"failed",
				`Codex image generation failed.\nElapsed: ${(elapsedMs / 1_000).toFixed(1)}s\n${diagnostic}`,
				{ error: diagnostic, shellId: launched.shellId, elapsedMs },
			);
			return;
		}

		postJobMessage(
			"completed",
			`Codex image generation completed.\nElapsed: ${(elapsedMs / 1_000).toFixed(1)}s\nLocal path: ${request.outputPath}`,
			{
				path: request.outputPath,
				shellId: launched.shellId,
				elapsedMs,
			},
		);
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Codex Imagegen",
		description:
			"Run Codex image generation in the background and deliver its staged result.png to the requested path. Pass the user's image intent, content, and style without rewriting it into a detailed generation recipe. Requires pi-shelld as a separately loaded extension.",
		promptSnippet:
			"Generate a PNG with Codex from the user's image intent, content, and style",
		parameters: Type.Object(
			{
				imagePrompt: Type.String({
					minLength: 1,
					maxLength: 20_000,
					description:
						"The user's image intent, content, and style; include size only when relevant to that intent",
				}),
				outputPath: Type.String({
					minLength: 1,
					maxLength: 4_096,
					pattern: "\\.[pP][nN][gG]$",
					description:
						"Final non-existing PNG path, absolute or relative to pi's cwd",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(...args) {
			const [, params, signal, , ctx] = args;
			const imagePrompt = params.imagePrompt.trim();
			if (!imagePrompt) {
				throw new Error(`${TOOL_NAME}: imagePrompt cannot be blank`);
			}
			if (signal?.aborted) throw new Error(`${TOOL_NAME}: cancelled before start`);

			const service = resolveShelldService(pi);
			const outputPath = resolveOutputPath(params.outputPath, ctx.cwd);
			if (!/\.png$/i.test(outputPath)) {
				throw new Error(`${TOOL_NAME}: outputPath must end in .png`);
			}
			if (existsSync(outputPath)) {
				throw new Error(`${TOOL_NAME}: outputPath already exists: ${outputPath}`);
			}
			if (reservedOutputPaths.has(outputPath)) {
				throw new Error(
					`${TOOL_NAME}: outputPath is already reserved by a running job`,
				);
			}
			reservedOutputPaths.add(outputPath);

			const controller = new AbortController();
			const request: CodexImagegenRequest = { imagePrompt, outputPath };
			let launched: LaunchedCodexShell;
			try {
				launched = await launchCodexShell(request, service);
			} catch (error) {
				reservedOutputPaths.delete(outputPath);
				throw error;
			}

			const completion = finishJob({
				request,
				service,
				launched,
				controller,
			}).finally(() => {
				jobs.delete(launched.shellId);
				reservedOutputPaths.delete(outputPath);
			});
			jobs.set(launched.shellId, { controller, completion });
			void completion;

			return {
				content: [
					{
						type: "text",
						text: `Codex image generation started. Shell ID: ${launched.shellId}. Final output: ${outputPath}. Watch it in the ⭕shell monitor; completion will be posted to chat.`,
					},
				],
				details: {
					shellId: launched.shellId,
					status: "running",
					outputPath,
				},
			};
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const job of jobs.values()) job.controller.abort();
		await Promise.allSettled([...jobs.values()].map((job) => job.completion));
		jobs.clear();
	});
}
