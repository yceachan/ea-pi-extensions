import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve, join } from "node:path";

/** The protocol version shared by the extension, controller, and forked runtime. */
export const WSL_BROWSER_PROTOCOL_VERSION = 1 as const;
export const WSL_BROWSER_TOOL_NAME = "wsl_browser" as const;
export const SHELLD_SERVICE_CHANNEL = "pi-shelld:service:v1" as const;
export const MANAGED_CONTROL_META = "managed_control" as const;

export const BROWSER_MODES = [
	"headless",
	"headed-tmp-profile",
	"main-profile",
] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

export const LIFECYCLE_ACTIONS = [
	"acquire",
	"retain",
	"release",
	"status",
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export const MANAGED_CONTROL_ACTIONS = [
	"health",
	"acquire-root",
	"release-root",
	"status",
	"shutdown",
] as const;
export type ManagedControlAction = (typeof MANAGED_CONTROL_ACTIONS)[number];

export type BrowserKind = "edge" | "chrome";
export type BrowserSelection = "auto" | BrowserKind;
export type DaemonStatus =
	| "stopped"
	| "starting"
	| "running"
	| "exited"
	| "failed";

export interface ErrorPayload {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface ControlSuccess<T = Record<string, unknown>> {
	ok: true;
	data: T;
}

export interface ControlFailure {
	ok: false;
	error: ErrorPayload;
}

export type ControlResponse<T = Record<string, unknown>> =
	| ControlSuccess<T>
	| ControlFailure;

/**
 * Internal controller → managed daemon request.
 *
 * The token is deliberately part of the in-memory request only. It must never
 * be copied into a session descriptor consumed by the unprivileged wrapper.
 */
export interface ManagedControlRequest {
	meta: typeof MANAGED_CONTROL_META;
	token: string;
	action: ManagedControlAction;
	mode?: BrowserMode;
	profile?: string;
	marker?: string;
	targetId?: string;
}

export interface AcquireRootData {
	leaseId: string;
	rootTargetId: string;
	ownedTargetIds: string[];
	mode: BrowserMode;
}

export interface LeaseStatus extends AcquireRootData {
	retained: boolean;
}

export interface RuntimeStatusData extends Record<string, unknown> {
	daemon?: DaemonStatus;
	lease?: Partial<LeaseStatus>;
	[key: string]: unknown;
}

export interface ShelldExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
}

export interface ShelldStartResult {
	shellId: string;
	/** Optional when a pi-shelld implementation exposes the child pid. */
	pid?: number;
	logFile: string;
	startedAt: number;
	settled: Promise<ShelldExit>;
}

/** Only the stable pi-shelld v1 surface is required from this package. */
export interface ShelldServiceV1 {
	start(options: {
		command: string;
		cwd: string;
		name?: string;
		/** Environment overlay kept out of pi-shelld's persisted command text. */
		env?: NodeJS.ProcessEnv;
	}): Promise<ShelldStartResult>;
	close(shellId: string): Promise<void>;
}

export interface SessionIdentity {
	/** The opaque Pi session id when one is available, otherwise the session path. */
	sessionId: string;
	/** Session file as supplied by Pi, when available. */
	sessionFile?: string;
	/** Stable, path-safe key shared by the extension and the shell wrapper. */
	sessionKey: string;
}

export interface DescriptorDaemon {
	status: DaemonStatus;
	pid?: number;
	shellId?: string;
	logPath?: string;
	startedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
}

export interface DescriptorBrowser {
	kind: BrowserKind;
	mode: BrowserMode;
	profileDirectory?: string;
	temporary: boolean;
}

/**
 * Session descriptor visible to the wrapper. Keep this intentionally narrow:
 * no control token and no raw CDP endpoint can cross this boundary.
 */
export interface SessionDescriptor {
	version: typeof WSL_BROWSER_PROTOCOL_VERSION;
	sessionId: string;
	sessionKey: string;
	sessionFile?: string;
	socketPath: string;
	/** Safe, session-private paths shared with the managed wrapper/runtime. */
	runtimeDir: string;
	tmpDir: string;
	daemon: DescriptorDaemon;
	browser?: DescriptorBrowser;
	lease?: LeaseStatus;
	updatedAt: number;
}

export class WslBrowserError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: string, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "WslBrowserError";
		this.code = code;
		this.details = details;
	}

	toJSON(): {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	} {
		return {
			code: this.code,
			message: this.message,
			...(this.details ? { details: this.details } : {}),
		};
	}
}

export function isControlSuccess<T>(
	response: ControlResponse<T>,
): response is ControlSuccess<T> {
	return response.ok === true;
}

export function isControlFailure(
	response: ControlResponse<unknown>,
): response is ControlFailure {
	return response.ok === false;
}

export function assertControlSuccess<T>(response: ControlResponse<T>): T {
	if (response.ok) return response.data;
	throw new WslBrowserError(
		response.error.code,
		response.error.message,
		response.error.details,
	);
}

/** Encode one newline-delimited JSON request for the Unix socket. */
export function encodeControlRequest(request: ManagedControlRequest): string {
	return `${JSON.stringify(request)}\n`;
}

/**
 * Parse and validate the stable response envelope. Runtime details stay open
 * ended so a newer fork can add status fields without breaking this package.
 */
export function parseControlResponse<T = Record<string, unknown>>(
	value: unknown,
): ControlResponse<T> {
	if (!value || typeof value !== "object") {
		throw new WslBrowserError(
			"invalid_control_response",
			"managed daemon returned a non-object response",
		);
	}
	const response = value as Partial<ControlResponse<T>>;
	if (response.ok === true && "data" in response) {
		return { ok: true, data: response.data as T };
	}
	if (
		response.ok === false &&
		response.error &&
		typeof response.error === "object"
	) {
		const error = response.error as Partial<ErrorPayload>;
		if (typeof error.code === "string" && typeof error.message === "string") {
			return {
				ok: false,
				error: {
					code: error.code,
					message: error.message,
					...(error.details && typeof error.details === "object"
						? { details: error.details as Record<string, unknown> }
						: {}),
				},
			};
		}
	}
	throw new WslBrowserError(
		"invalid_control_response",
		"managed daemon returned an invalid response envelope",
		{ response: value as Record<string, unknown> },
	);
}

/**
 * Resolve the identity used for all package state. Session files are preferred
 * when present because Pi exposes them to both extension code and bash tools;
 * PI_SESSION_ID remains a fallback for runtimes that do not expose a file.
 */
export function resolveSessionIdentity(
	input: {
		sessionId?: string;
		sessionFile?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
): SessionIdentity {
	const env = input.env ?? process.env;
	const sessionFile = cleanOptional(input.sessionFile ?? env.PI_SESSION_FILE);
	const sessionId = cleanOptional(input.sessionId ?? env.PI_SESSION_ID);
	const canonical = sessionFile
		? `file:${resolve(sessionFile)}`
		: sessionId
			? `id:${sessionId}`
			: undefined;
	if (!canonical) {
		throw new WslBrowserError(
			"session_identity_missing",
			"pi-wsl-browser requires PI_SESSION_ID or PI_SESSION_FILE",
		);
	}
	const key = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
	return {
		sessionId: sessionId ?? sessionFile!,
		sessionFile,
		sessionKey: key,
	};
}

function cleanOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(
		env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
	);
}

function sessionsDirectory(agentDir: string): string {
	return join(resolve(agentDir), "pi-wsl-browser", "sessions");
}

/** Private per-session state root shared by the controller and wrapper. */
export function sessionStateDir(
	sessionKey: string,
	agentDir = defaultAgentDir(),
): string {
	return join(sessionsDirectory(agentDir), sessionKey);
}

/** Per-session runtime state consumed by the managed Python fork. */
export function sessionRuntimeDir(
	sessionKey: string,
	agentDir = defaultAgentDir(),
): string {
	return join(sessionStateDir(sessionKey, agentDir), "runtime");
}

/** Per-session temporary state consumed by the managed Python fork. */
export function sessionTempDir(
	sessionKey: string,
	agentDir = defaultAgentDir(),
): string {
	return join(sessionStateDir(sessionKey, agentDir), "tmp");
}

export function descriptorPath(
	sessionKey: string,
	agentDir = defaultAgentDir(),
): string {
	return join(sessionsDirectory(agentDir), `${sessionKey}.json`);
}

export function isBrowserMode(value: unknown): value is BrowserMode {
	return (
		typeof value === "string" &&
		(BROWSER_MODES as readonly string[]).includes(value)
	);
}

export function isLifecycleAction(value: unknown): value is LifecycleAction {
	return (
		typeof value === "string" &&
		(LIFECYCLE_ACTIONS as readonly string[]).includes(value)
	);
}

export function isAbsolutePath(value: string): boolean {
	return (
		isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
	);
}

/** Format an error as the structured JSON expected by tool callers. */
export function formatToolError(error: unknown): string {
	if (error instanceof WslBrowserError) {
		return JSON.stringify({ ok: false, error: error.toJSON() });
	}
	const message = error instanceof Error ? error.message : String(error);
	return JSON.stringify({
		ok: false,
		error: { code: "operation_failed", message },
	});
}
