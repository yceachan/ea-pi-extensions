import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import type { WslBrowserConfig } from "../src/config.ts";
import {
	isWindowsBackedPath,
	type BrowserInstallation,
} from "../src/discovery.ts";
import type { BrowserMode } from "../src/protocol.ts";
import { WslBrowserError } from "../src/protocol.ts";

export interface DevToolsEndpoint {
	port: number;
	webSocketPath: string;
	webSocketUrl: string;
	httpUrl: string;
}

export interface BrowserProcessHandle {
	pid?: number;
}

export interface BrowserProcessOperations {
	launch(executable: string, args: string[]): Promise<BrowserProcessHandle>;
	terminate(options: {
		kind: BrowserInstallation["kind"];
		marker: string;
		profilePath: string;
	}): Promise<void>;
}

export interface BrowserLaunchOptions {
	installation: BrowserInstallation;
	mode: BrowserMode;
	sessionKey: string;
	config: WslBrowserConfig;
	process?: BrowserProcessOperations;
	toWindowsPath?: (path: string) => Promise<string>;
	toWslPath?: (path: string) => Promise<string>;
	ensureTemporaryProfileRoot?: (root: string) => Promise<void>;
	createTemporaryProfile?: (prefix: string) => Promise<string>;
	readEndpoint?: (profilePath: string) => Promise<DevToolsEndpoint | undefined>;
	waitForEndpoint?: (
		profilePath: string,
		options: {
			timeoutMs: number;
			pollIntervalMs: number;
			signal?: AbortSignal;
			onUpdate?: (message: string) => void;
		},
	) => Promise<DevToolsEndpoint>;
	random?: () => string;
	/** Absolute acquire deadline shared with main-profile endpoint + health waits. */
	deadline?: number;
	now?: () => number;
	signal?: AbortSignal;
	onUpdate?: (message: string) => void;
}

export interface BrowserHandle {
	kind: BrowserInstallation["kind"];
	mode: BrowserMode;
	executable: string;
	profileDirectory: string;
	userDataDir?: string;
	/** Temporary modes use a private root; main-profile points at user data. */
	profilePath: string;
	marker: string;
	temporary: boolean;
	pid?: number;
	cdp: DevToolsEndpoint;
	cdpEnvName: "BU_CDP_URL" | "BU_CDP_WS";
	cdpEnvValue: string;
}

export interface BrowserLaunchManager {
	launch(options: Omit<BrowserLaunchOptions, "process">): Promise<BrowserHandle>;
	close(handle: BrowserHandle): Promise<void>;
}

const execFileAsync = promisify(execFile);
const DEFAULT_BROWSER_START_TIMEOUT_MS = 30_000;

export const MAIN_PROFILE_AUTHORIZATION_MESSAGE =
	"Waiting for Microsoft Edge authorization: open edge://inspect/#remote-debugging, enable remote debugging, and click Allow when prompted.";

async function resolveTemporaryProfileRoot(
	options: BrowserLaunchOptions,
): Promise<string> {
	const source =
		options.config.tempProfileRoot ?? options.installation.temporaryProfileRoot;
	if (!source) {
		throw new WslBrowserError(
			"windows_temp_unavailable",
			"Windows temporary storage was not discovered for the browser profile",
		);
	}
	const root = await (options.toWslPath ?? toWslPath)(source);
	if (!isWindowsBackedPath(root)) {
		throw new WslBrowserError(
			"temporary_profile_root_invalid",
			"temporary browser profiles must be stored on a Windows-backed /mnt/<drive> path",
			{ path: source },
		);
	}
	return resolve(root);
}

async function defaultCreateTemporaryProfile(prefix: string): Promise<string> {
	return mkdtemp(prefix);
}

async function defaultEnsureTemporaryProfileRoot(root: string): Promise<void> {
	await mkdir(root, { recursive: true, mode: 0o700 });
}

/** Convert a Windows path to WSL form before using it with POSIX fs APIs. */
export async function toWslPath(path: string): Promise<string> {
	const value = path.trim();
	if (!value) return value;
	if (value.startsWith("/")) return resolve(value);
	if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
		try {
			const result = await execFileAsync("wslpath", ["-u", value], {
				encoding: "utf8",
				maxBuffer: 32 * 1024,
			});
			const converted = String(result.stdout).trim();
			if (converted.startsWith("/")) return resolve(converted);
		} catch {
			// Fall back to the conventional drive mapping in minimal WSL images.
		}
		if (/^[A-Za-z]:[\\/]/.test(value)) {
			const drive = value[0].toLowerCase();
			return `/mnt/${drive}/${value.slice(3).replaceAll("\\", "/")}`;
		}
	}
	return value;
}

/** Create the default browser operation implementation used by the controller. */
export function createBrowserLaunchManager(
	operations: BrowserProcessOperations = createDefaultProcessOperations(),
): BrowserLaunchManager {
	return {
		async launch(options) {
			return launchBrowser({ ...options, process: operations });
		},
		async close(handle) {
			if (!handle.temporary) return;
			await operations.terminate({
				kind: handle.kind,
				marker: handle.marker,
				profilePath: handle.profilePath,
			});
			await removeTemporaryProfile(handle.profilePath);
		},
	};
}

/**
 * Start one browser process and resolve the dynamic DevToolsActivePort written
 * by that exact profile. The endpoint is always allocated dynamically.
 */
export async function launchBrowser(
	options: BrowserLaunchOptions,
): Promise<BrowserHandle> {
	const {
		installation,
		mode,
		sessionKey,
		config,
		process: processOperations = createDefaultProcessOperations(),
	} = options;
	const random = options.random ?? (() => randomToken());
	const marker = `pi-wsl-browser-${sessionKey}-${random()}`;
	const temporary = mode !== "main-profile";
	let profilePath: string | undefined;

	try {
		if (temporary) {
			const root = await resolveTemporaryProfileRoot(options);
			await (
				options.ensureTemporaryProfileRoot ?? defaultEnsureTemporaryProfileRoot
			)(root);
			const prefix = join(root, `${marker}-`);
			profilePath = await (
				options.createTemporaryProfile ?? defaultCreateTemporaryProfile
			)(prefix);
		} else {
			if (!installation.userDataDir) {
				throw new WslBrowserError(
					"browser_user_data_missing",
					"main-profile requires a discovered Windows user-data directory",
					{ kind: installation.kind },
				);
			}
			profilePath = installation.userDataDir;
		}
		if (!profilePath) {
			throw new WslBrowserError(
				"browser_user_data_missing",
				"browser profile path could not be resolved",
			);
		}

		const profileWin = await (options.toWindowsPath ?? toWindowsPath)(
			profilePath,
		);
		const existingEndpoint =
			mode === "main-profile"
				? await (options.readEndpoint ?? readDevToolsEndpoint)(profilePath)
				: undefined;
		const args = buildBrowserArguments({
			installation,
			mode,
			profileWin,
			profileDirectory: installation.profileDirectory,
			marker,
			temporary,
			includeRemoteDebuggingPort: existingEndpoint === undefined,
		});
		// Starting msedge.exe with an already-running main profile forwards the
		// marker URL to the user's browser and can create an unrelated New Tab.
		// Reuse the discovered endpoint instead; the managed daemon will create and
		// claim its marker root through CDP without disturbing existing tabs.
		const processHandle = existingEndpoint
			? {}
			: await processOperations.launch(installation.executable, args);

		const now = options.now ?? Date.now;
		let endpointTimeoutMs =
			config.startupTimeoutMs || DEFAULT_BROWSER_START_TIMEOUT_MS;
		if (mode === "main-profile") {
			endpointTimeoutMs =
				options.deadline === undefined
					? config.authorizationTimeoutMs
					: Math.max(0, options.deadline - now());
		}
		if (mode === "main-profile" && endpointTimeoutMs <= 0) {
			throw new WslBrowserError(
				"authorization_timeout",
				"browser authorization did not complete within 180 seconds",
				{ timeoutMs: config.authorizationTimeoutMs },
			);
		}
		const endpoint =
			existingEndpoint ??
			(await (options.waitForEndpoint ?? waitForDevToolsEndpoint)(profilePath, {
				timeoutMs: endpointTimeoutMs,
				pollIntervalMs: config.pollIntervalMs,
				signal: options.signal,
				onUpdate:
					mode === "main-profile"
						? () => options.onUpdate?.(MAIN_PROFILE_AUTHORIZATION_MESSAGE)
						: options.onUpdate,
			}));
		if (
			mode === "main-profile" &&
			options.deadline !== undefined &&
			now() >= options.deadline
		) {
			throw new WslBrowserError(
				"authorization_timeout",
				"browser authorization did not complete within 180 seconds",
				{ timeoutMs: config.authorizationTimeoutMs },
			);
		}
		const cdpEnvName = mode === "main-profile" ? "BU_CDP_WS" : "BU_CDP_URL";
		return {
			kind: installation.kind,
			mode,
			executable: installation.executable,
			profileDirectory: installation.profileDirectory,
			userDataDir: installation.userDataDir,
			profilePath,
			marker,
			temporary,
			pid: processHandle.pid,
			cdp: endpoint,
			cdpEnvName,
			cdpEnvValue:
				cdpEnvName === "BU_CDP_WS" ? endpoint.webSocketUrl : endpoint.httpUrl,
		};
	} catch (error) {
		// If endpoint discovery or launch fails, terminate only the private
		// temporary process and remove its profile. Main profile is untouched.
		if (temporary && profilePath) {
			await processOperations
				.terminate({
					kind: installation.kind,
					marker,
					profilePath,
				})
				.catch(() => undefined);
			await removeTemporaryProfile(profilePath).catch(() => undefined);
		}
		throw error;
	}
}

export interface BrowserArgumentOptions {
	installation: BrowserInstallation;
	mode: BrowserMode;
	profileWin: string;
	profileDirectory: string;
	marker: string;
	temporary: boolean;
	includeRemoteDebuggingPort: boolean;
}

export function buildBrowserArguments(
	options: BrowserArgumentOptions,
): string[] {
	const args: string[] = [];
	if (options.includeRemoteDebuggingPort) args.push("--remote-debugging-port=0");
	if (options.temporary || options.installation.userDataDir) {
		args.push(`--user-data-dir=${options.profileWin}`);
	}
	if (options.profileDirectory) {
		args.push(`--profile-directory=${options.profileDirectory}`);
	}
	if (options.temporary) {
		args.push("--no-first-run", "--no-default-browser-check");
		args.push("--disable-features=Translate");
	}
	if (options.mode === "headless") {
		args.push("--headless=new", "--disable-gpu", "--hide-scrollbars");
	}
	// The marker is the exact root-claim boundary used by acquire-root. Keep it
	// in the initial URL rather than relying on target-list ordering.
	args.push(`about:blank#${options.marker}`);
	return args;
}

export async function readDevToolsEndpoint(
	profilePath: string,
): Promise<DevToolsEndpoint | undefined> {
	try {
		const raw = await readFile(join(profilePath, "DevToolsActivePort"), "utf8");
		const lines = raw
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const port = Number(lines[0]);
		const webSocketPath = lines[1];
		if (
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65_535 ||
			!webSocketPath?.startsWith("/")
		) {
			return undefined;
		}
		return {
			port,
			webSocketPath,
			webSocketUrl: `ws://127.0.0.1:${port}${webSocketPath}`,
			httpUrl: `http://127.0.0.1:${port}`,
		};
	} catch {
		return undefined;
	}
}

export async function waitForDevToolsEndpoint(
	profilePath: string,
	options: {
		timeoutMs: number;
		pollIntervalMs: number;
		signal?: AbortSignal;
		onUpdate?: (message: string) => void;
	} = {
		timeoutMs: DEFAULT_BROWSER_START_TIMEOUT_MS,
		pollIntervalMs: 250,
	},
): Promise<DevToolsEndpoint> {
	const deadline = Date.now() + options.timeoutMs;
	let nextUpdate = 0;
	while (Date.now() <= deadline) {
		if (options.signal?.aborted) {
			throw new WslBrowserError("cancelled", "browser startup was cancelled");
		}
		const endpoint = await readDevToolsEndpoint(profilePath);
		if (endpoint) return endpoint;
		const now = Date.now();
		if (options.onUpdate && now >= nextUpdate) {
			options.onUpdate(
				"Waiting for the browser DevTools endpoint; approve authorization if Windows prompts.",
			);
			nextUpdate = now + 1_000;
		}
		const remaining = Math.max(0, deadline - Date.now());
		if (!remaining) break;
		await delay(Math.min(options.pollIntervalMs, remaining), options.signal);
	}
	throw new WslBrowserError(
		"browser_endpoint_timeout",
		`DevToolsActivePort did not appear within ${options.timeoutMs}ms`,
		{ profilePath, timeoutMs: options.timeoutMs },
	);
}

export async function toWindowsPath(path: string): Promise<string> {
	const value = path.trim();
	if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
		return value.replaceAll("/", "\\");
	}
	try {
		const result = await execFileAsync("wslpath", ["-w", value], {
			encoding: "utf8",
			maxBuffer: 32 * 1024,
		});
		const converted = String(result.stdout).trim();
		if (converted) return converted;
	} catch {
		// Fall back to the conventional /mnt/<drive> mapping in test/minimal WSL.
	}
	if (/^\/mnt\/[A-Za-z](\/|$)/.test(value)) {
		const drive = value[5].toUpperCase();
		return `${drive}:\\${value.slice(7).replaceAll("/", "\\")}`;
	}
	return value;
}

export async function removeTemporaryProfile(
	profilePath: string,
): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			await rm(profilePath, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 9) throw error;
			await delay(100);
		}
	}
}

function createDefaultProcessOperations(): BrowserProcessOperations {
	return {
		async launch(executable, args) {
			return new Promise<BrowserProcessHandle>((resolvePromise, rejectPromise) => {
				const child = spawn(executable, args, {
					detached: true,
					stdio: "ignore",
					windowsHide: true,
				});
				child.once("error", rejectPromise);
				child.once("spawn", () => {
					child.unref();
					resolvePromise({ pid: child.pid });
				});
			});
		},
		async terminate({ kind, marker }) {
			const processNames =
				kind === "edge" ? ["msedge.exe"] : ["chrome.exe", "chromium.exe"];
			const filters = processNames
				.map(
					(name) =>
						`Get-CimInstance Win32_Process -Filter \"Name='${name}'\" | Where-Object { $_.CommandLine -like '*${escapePowerShellWildcard(marker)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
				)
				.join("; ");
			try {
				await execFileAsync(
					"powershell.exe",
					["-NoProfile", "-NonInteractive", "-Command", filters],
					{ timeout: 10_000, maxBuffer: 32 * 1024 },
				);
			} catch {
				// The browser may have exited on its own; cleanup still proceeds.
			}
		},
	};
}

function escapePowerShellWildcard(value: string): string {
	return value.replaceAll("'", "''").replaceAll("*", "`*").replaceAll("?", "`?");
}

function randomToken(): string {
	return randomBytes(12).toString("hex");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		if (signal?.aborted) {
			rejectPromise(
				new WslBrowserError("cancelled", "browser operation was cancelled"),
			);
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(
				new WslBrowserError("cancelled", "browser operation was cancelled"),
			);
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
