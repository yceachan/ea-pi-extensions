import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	defaultAgentDir,
	type BrowserKind,
	type BrowserSelection,
	isAbsolutePath,
} from "./protocol.ts";

export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

export interface RuntimeConfig {
	/** Runner used only for the package-private fork (`uv` in production). */
	python: string;
	/** Import root containing the package-private browser_harness module. */
	root: string;
	/** Project root containing pyproject.toml and the pinned uv.lock. */
	project: string;
}

export interface WslBrowserConfig {
	/** `auto` means Edge first, Chrome only when Edge is absent. */
	browser: BrowserSelection;
	executable?: string;
	userDataDir?: string;
	profileDirectory?: string;
	tempProfileRoot?: string;
	startupTimeoutMs: number;
	/** Fixed by the contract; not user-configurable in the public config file. */
	authorizationTimeoutMs: number;
	pollIntervalMs: number;
	controlTimeoutMs: number;
	runtime: RuntimeConfig;
	/** Root used for descriptors and per-session package state. */
	agentDir: string;
}

export interface LoadConfigOptions {
	extensionDir?: string;
	bundleConfigPath?: string;
	userConfigPath?: string;
	userConfigDir?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onWarning?: (message: string) => void;
	/** Test-only override for the immutable authorization timeout. */
	authorizationTimeoutMs?: number;
}

interface ConfigFile {
	browser?: unknown;
	executable?: unknown;
	userDataDir?: unknown;
	profileDirectory?: unknown;
	tempProfileRoot?: unknown;
	startupTimeoutMs?: unknown;
	authorizationTimeoutMs?: unknown;
	pollIntervalMs?: unknown;
	controlTimeoutMs?: unknown;
}

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULTS: Omit<WslBrowserConfig, "agentDir" | "runtime"> = {
	browser: "auto",
	startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
	authorizationTimeoutMs: DEFAULT_AUTHORIZATION_TIMEOUT_MS,
	pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
	controlTimeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
};

/**
 * Load package defaults followed by the user override. The project directory
 * is intentionally not a configuration layer: the contract only permits
 * `$PI_CODING_AGENT_DIR/pi-wsl-browser/config.json` above bundle defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): WslBrowserConfig {
	const env = options.env ?? process.env;
	const extensionDir = resolve(options.extensionDir ?? join(PACKAGE_DIR, ".."));
	const agentDir = defaultAgentDir(env);
	const bundlePath =
		options.bundleConfigPath ?? join(extensionDir, "config.json");
	const userPath =
		options.userConfigPath ??
		join(
			options.userConfigDir ?? join(agentDir, "pi-wsl-browser"),
			"config.json",
		);

	const bundle = readConfigFile(bundlePath, options.onWarning);
	const user = readConfigFile(userPath, options.onWarning);
	const merged = mergeConfig(bundle, user);
	const browser = browserSelection(merged.browser, options.onWarning);
	const startupTimeoutMs = positiveInteger(
		merged.startupTimeoutMs,
		DEFAULTS.startupTimeoutMs,
		"startupTimeoutMs",
		options.onWarning,
	);
	const pollIntervalMs = positiveInteger(
		merged.pollIntervalMs,
		DEFAULTS.pollIntervalMs,
		"pollIntervalMs",
		options.onWarning,
	);
	const controlTimeoutMs = positiveInteger(
		merged.controlTimeoutMs,
		DEFAULTS.controlTimeoutMs,
		"controlTimeoutMs",
		options.onWarning,
	);
	const authorizationTimeoutMs =
		options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;

	return {
		browser,
		executable: optionalString(merged.executable),
		userDataDir: optionalPath(merged.userDataDir),
		profileDirectory: optionalProfile(merged.profileDirectory),
		tempProfileRoot: optionalPath(merged.tempProfileRoot),
		startupTimeoutMs,
		authorizationTimeoutMs,
		pollIntervalMs,
		controlTimeoutMs,
		// Runtime selection is immutable: user/bundle config cannot replace the
		// package-private fork or its frozen uv project.
		runtime: {
			python: "uv",
			root: resolve(extensionDir, "runtime", "browser-harness", "src"),
			project: resolve(extensionDir, "runtime", "browser-harness"),
		},
		agentDir,
	};
}

function readConfigFile(
	path: string,
	onWarning: ((message: string) => void) | undefined,
): ConfigFile {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			onWarning?.(
				`pi-wsl-browser: invalid config at ${path} (expected an object)`,
			);
			return {};
		}
		return value as ConfigFile;
	} catch (error) {
		onWarning?.(
			`pi-wsl-browser: invalid config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {};
	}
}

function mergeConfig(base: ConfigFile, override: ConfigFile): ConfigFile {
	return { ...base, ...override };
}

function browserSelection(
	value: unknown,
	onWarning: ((message: string) => void) | undefined,
): BrowserSelection {
	if (value === undefined) return DEFAULTS.browser;
	if (value === "auto" || value === "edge" || value === "chrome") {
		return value;
	}
	onWarning?.(
		`pi-wsl-browser: invalid browser selection ${JSON.stringify(value)}; using auto`,
	);
	return DEFAULTS.browser;
}

function positiveInteger(
	value: unknown,
	fallback: number,
	name: string,
	onWarning: ((message: string) => void) | undefined,
): number {
	if (value === undefined) return fallback;
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= 24 * 60 * 60 * 1_000
	) {
		return value;
	}
	onWarning?.(
		`pi-wsl-browser: invalid ${name} ${JSON.stringify(value)}; using ${fallback}`,
	);
	return fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPath(value: unknown): string | undefined {
	const path = optionalString(value);
	if (!path) return undefined;
	return path.startsWith("~/")
		? resolve(homedir(), path.slice(2))
		: isAbsolutePath(path)
			? path
			: resolve(path);
}

function optionalProfile(value: unknown): string | undefined {
	const profile = optionalString(value);
	if (!profile) return undefined;
	// A Chromium profile directory is a single child of User Data. Reject
	// separators and traversal rather than allowing config to escape the root.
	if (
		profile === "." ||
		profile === ".." ||
		profile.includes("/") ||
		profile.includes("\\")
	) {
		return undefined;
	}
	return profile;
}

export function configPath(agentDir = defaultAgentDir()): string {
	return join(agentDir, "pi-wsl-browser", "config.json");
}

export function browserKindFromExecutable(executable: string): BrowserKind {
	return /chrome|chromium/i.test(executable) ? "chrome" : "edge";
}
