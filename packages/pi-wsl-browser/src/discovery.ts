import { access, constants, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { browserKindFromExecutable, type WslBrowserConfig } from "./config.ts";
import {
	type BrowserKind,
	type BrowserMode,
	type BrowserSelection,
	WslBrowserError,
} from "./protocol.ts";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

export interface DiscoveryCommandOptions {
	timeoutMs?: number;
}

export type DiscoveryCommand = (
	file: string,
	args: string[],
	options?: DiscoveryCommandOptions,
) => Promise<CommandResult>;

export interface BrowserInstallation {
	kind: BrowserKind;
	executable: string;
	/** Windows user-data root in WSL path form, when discovered. */
	userDataDir?: string;
	/** Windows-backed temporary root in WSL path form for temporary modes. */
	temporaryProfileRoot?: string;
	profileDirectory: string;
	profileSource: "config" | "last_used" | "default";
	environmentPresent: true;
}

export interface DiscoveryOptions {
	env?: NodeJS.ProcessEnv;
	run?: DiscoveryCommand;
	pathExists?: (path: string) => Promise<boolean>;
	/** Override the local-app-data lookup in hermetic tests. */
	localAppData?: string;
	/** Override Windows [IO.Path]::GetTempPath() in hermetic tests. */
	windowsTempPath?: string;
}

const WINDOWS_EDGE_EXECUTABLES = [
	"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const WINDOWS_CHROME_EXECUTABLES = [
	"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
	"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const EDGE_USER_DATA_RELATIVE = "Microsoft/Edge/User Data";
const CHROME_USER_DATA_RELATIVE = "Google/Chrome/User Data";
const SAFE_PROFILE = /^[^/\\]+$/;

/** Only drive-mounted WSL paths are safe for a Windows Chromium profile. */
export function isWindowsBackedPath(value: string): boolean {
	return /^\/mnt\/[A-Za-z](?:\/|$)/.test(value.trim());
}

const execFileAsync = promisify(execFile);

/**
 * Discover the Windows browser without embedding a Windows username. Edge is
 * intentionally selected before Chrome; Chrome is considered only when the
 * entire Edge environment (executable and user-data root) is absent.
 */
export class WindowsBrowserDiscovery {
	private readonly env: NodeJS.ProcessEnv;
	private readonly runCommand: DiscoveryCommand;
	private readonly pathExists: (path: string) => Promise<boolean>;
	private readonly configuredLocalAppData?: string;
	private readonly configuredWindowsTempPath?: string;

	constructor(options: DiscoveryOptions = {}) {
		this.env = options.env ?? process.env;
		this.runCommand = options.run ?? defaultCommand;
		this.pathExists = options.pathExists ?? defaultPathExists;
		this.configuredLocalAppData = options.localAppData;
		this.configuredWindowsTempPath = options.windowsTempPath;
	}

	async discover(
		config: WslBrowserConfig,
		mode: BrowserMode = "headless",
	): Promise<BrowserInstallation> {
		const localAppData = await this.findLocalAppData();
		const configuredExecutable = config.executable;
		let selection: BrowserSelection = config.browser;
		if (configuredExecutable && config.browser === "auto") {
			selection = browserKindFromExecutable(configuredExecutable);
		} else if (
			!configuredExecutable &&
			config.userDataDir &&
			config.browser === "auto"
		) {
			selection = "edge";
		}
		const explicit = Boolean(
			configuredExecutable || config.userDataDir || config.browser !== "auto",
		);

		if (explicit) {
			const kind = selection === "auto" ? "edge" : selection;
			return this.requireCandidate(
				kind,
				config,
				mode,
				localAppData,
				configuredExecutable,
				true,
			);
		}

		const edge = await this.findCandidate("edge", localAppData);
		if (edge.executable) {
			// An installed Edge executable that cannot be launched is a hard
			// error. Data left behind without the executable does not block the
			// Chrome fallback.
			return this.requireCandidate(
				"edge",
				config,
				mode,
				localAppData,
				edge.executable,
				false,
				edge,
			);
		}

		const chrome = await this.findCandidate("chrome", localAppData);
		if (!chrome.executable) {
			throw new WslBrowserError(
				"browser_not_found",
				"Microsoft Edge was not found and Chrome fallback is unavailable",
				{
					attempted: ["edge", "chrome"],
					localAppData: localAppData ?? null,
				},
			);
		}
		return this.requireCandidate(
			"chrome",
			config,
			mode,
			localAppData,
			chrome.executable,
			false,
			chrome,
		);
	}

	private async requireCandidate(
		kind: BrowserKind,
		config: WslBrowserConfig,
		mode: BrowserMode,
		localAppData: string | undefined,
		configuredExecutable: string | undefined,
		explicit: boolean,
		candidate?: Candidate,
	): Promise<BrowserInstallation> {
		const found =
			candidate ??
			(await this.findCandidate(kind, localAppData, configuredExecutable));
		const executable = configuredExecutable
			? await this.toWslPath(configuredExecutable)
			: found.executable;
		if (!executable || !(await this.pathExists(executable))) {
			throw new WslBrowserError(
				"browser_executable_missing",
				`${kind === "edge" ? "Microsoft Edge" : "Chrome"} executable was not found`,
				{ kind, executable: executable ?? null, explicit },
			);
		}

		const configuredDataDir = config.userDataDir
			? await this.toWslPath(config.userDataDir)
			: undefined;
		const userDataDir = configuredDataDir ?? found.userDataDir;
		if (mode === "main-profile" && !userDataDir) {
			throw new WslBrowserError(
				"browser_user_data_missing",
				`Cannot locate the ${kind} Windows user-data directory for main-profile`,
				{ kind, localAppData: localAppData ?? null },
			);
		}
		if (
			mode === "main-profile" &&
			userDataDir &&
			!(await this.pathExists(userDataDir))
		) {
			throw new WslBrowserError(
				"browser_user_data_missing",
				`The configured ${kind} user-data directory does not exist`,
				{ kind, userDataDir },
			);
		}

		// Temporary modes never reuse the user's inferred profile name; they
		// start a fresh profile tree and use Chromium's stable Default child.
		if (mode !== "main-profile") {
			const temporaryProfileRoot = await this.resolveTemporaryProfileRoot(config);
			return {
				kind,
				executable,
				userDataDir,
				temporaryProfileRoot,
				profileDirectory: "Default",
				profileSource: "default",
				environmentPresent: true,
			};
		}

		const configuredProfile = config.profileDirectory;
		if (configuredProfile) {
			return {
				kind,
				executable,
				userDataDir,
				profileDirectory: configuredProfile,
				profileSource: "config",
				environmentPresent: true,
			};
		}

		const inferred = userDataDir
			? await inferLastUsedProfile(userDataDir)
			: { profileDirectory: "Default", profileSource: "default" as const };
		return {
			kind,
			executable,
			userDataDir,
			profileDirectory: inferred.profileDirectory,
			profileSource: inferred.profileSource,
			environmentPresent: true,
		};
	}

	private async findCandidate(
		kind: BrowserKind,
		localAppData: string | undefined,
		configuredExecutable?: string,
	): Promise<Candidate> {
		const expectedUserData = localAppData
			? join(
					localAppData,
					kind === "edge" ? EDGE_USER_DATA_RELATIVE : CHROME_USER_DATA_RELATIVE,
				)
			: undefined;
		const executable = configuredExecutable
			? await this.toWslPath(configuredExecutable)
			: await this.findExecutable(kind, localAppData);
		const executablePresent = Boolean(
			executable && (await this.pathExists(executable)),
		);
		const dataPresent = Boolean(
			expectedUserData && (await this.pathExists(expectedUserData)),
		);
		return {
			executable: executablePresent ? executable : undefined,
			userDataDir: dataPresent ? expectedUserData : undefined,
		};
	}

	private async resolveTemporaryProfileRoot(
		config: WslBrowserConfig,
	): Promise<string> {
		const configured = config.tempProfileRoot;
		const raw =
			configured ??
			this.configuredWindowsTempPath ??
			(await this.findWindowsTempPath());
		if (!raw) {
			throw new WslBrowserError(
				"windows_temp_unavailable",
				"Windows temporary storage could not be discovered; configure a Windows-backed tempProfileRoot",
			);
		}
		const root = await this.toWslPath(raw);
		if (!isWindowsBackedPath(root)) {
			throw new WslBrowserError(
				"temporary_profile_root_invalid",
				"temporary browser profiles must be stored on a Windows-backed /mnt/<drive> path",
				{ path: raw },
			);
		}
		return root;
	}

	private async findWindowsTempPath(): Promise<string | undefined> {
		const command = "[IO.Path]::GetTempPath()";
		const powershell = await this.runCommand(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", command],
			{ timeoutMs: 5_000 },
		);
		return firstLine(powershell.stdout);
	}

	private async findExecutable(
		kind: BrowserKind,
		localAppData: string | undefined,
	): Promise<string | undefined> {
		const names = kind === "edge" ? ["msedge.exe"] : ["chrome.exe"];
		const known =
			kind === "edge" ? WINDOWS_EDGE_EXECUTABLES : WINDOWS_CHROME_EXECUTABLES;
		const localCandidate = localAppData
			? join(
					localAppData,
					kind === "edge"
						? "Microsoft/Edge/Application/msedge.exe"
						: "Google/Chrome/Application/chrome.exe",
				)
			: undefined;
		for (const path of [...known, localCandidate].filter(Boolean) as string[]) {
			if (await this.pathExists(path)) return path;
		}

		for (const name of names) {
			const which = await this.runCommand("which", [name]);
			const path = firstLine(which.stdout);
			if (path && (await this.pathExists(path))) return path;
		}

		const command =
			kind === "edge"
				? "(Get-Command msedge.exe -ErrorAction SilentlyContinue).Source"
				: "(Get-Command chrome.exe -ErrorAction SilentlyContinue).Source";
		const powershell = await this.runCommand(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", command],
			{ timeoutMs: 5_000 },
		);
		const path = firstLine(powershell.stdout);
		if (path) {
			const wslPath = await this.toWslPath(path);
			if (await this.pathExists(wslPath)) return wslPath;
		}
		return undefined;
	}

	private async findLocalAppData(): Promise<string | undefined> {
		if (this.configuredLocalAppData) {
			return this.toWslPath(this.configuredLocalAppData);
		}
		const envValue = this.env.LOCALAPPDATA?.trim();
		if (envValue) return this.toWslPath(envValue);
		const command =
			"[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)";
		const powershell = await this.runCommand(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", command],
			{ timeoutMs: 5_000 },
		);
		const path = firstLine(powershell.stdout);
		return path ? this.toWslPath(path) : undefined;
	}

	private async toWslPath(path: string): Promise<string> {
		const value = path.trim();
		if (!value) return value;
		if (value.startsWith("/")) return resolve(value);
		if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
			const converted = await this.runCommand("wslpath", ["-u", value]);
			const result = firstLine(converted.stdout);
			if (result?.startsWith("/")) return resolve(result);
			if (/^[A-Za-z]:[\\/]/.test(value)) {
				const drive = value[0].toLowerCase();
				return `/mnt/${drive}/${value.slice(3).replaceAll("\\", "/")}`;
			}
		}
		return value;
	}
}

interface Candidate {
	executable?: string;
	userDataDir?: string;
}

export async function inferLastUsedProfile(userDataDir: string): Promise<{
	profileDirectory: string;
	profileSource: "last_used" | "default";
}> {
	try {
		const raw = await readFile(join(userDataDir, "Local State"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		const lastUsed =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as { profile?: { last_used?: unknown } }).profile?.last_used
				: undefined;
		if (typeof lastUsed === "string" && SAFE_PROFILE.test(lastUsed)) {
			return { profileDirectory: lastUsed, profileSource: "last_used" };
		}
	} catch {
		// A missing or partially-written Local State is equivalent to Default.
	}
	return { profileDirectory: "Default", profileSource: "default" };
}

export async function discoverWindowsBrowser(
	config: WslBrowserConfig,
	mode: BrowserMode = "headless",
	options: DiscoveryOptions = {},
): Promise<BrowserInstallation> {
	return new WindowsBrowserDiscovery(options).discover(config, mode);
}

async function defaultPathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function defaultCommand(
	file: string,
	args: string[],
	options: DiscoveryCommandOptions = {},
): Promise<CommandResult> {
	try {
		const result = await execFileAsync(file, args, {
			timeout: options.timeoutMs ?? 5_000,
			maxBuffer: 128 * 1024,
			encoding: "utf8",
		});
		return {
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
			code: 0,
		};
	} catch (error) {
		const value = error as Error & {
			stdout?: string;
			stderr?: string;
			code?: number | string;
		};
		const numericCode =
			typeof value.code === "number"
				? value.code
				: value.code
					? Number(value.code)
					: null;
		return {
			stdout: String(value.stdout ?? ""),
			stderr: String(value.stderr ?? value.message ?? ""),
			code: Number.isFinite(numericCode) ? numericCode : null,
		};
	}
}

function firstLine(value: string): string | undefined {
	const line = value
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	return line || undefined;
}
