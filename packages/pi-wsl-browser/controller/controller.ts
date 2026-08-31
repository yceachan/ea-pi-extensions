import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	chmod,
	mkdir,
	readFile,
	rm,
	writeFile,
	rename,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WslBrowserConfig } from "../src/config.ts";
import {
	type BrowserInstallation,
	type DiscoveryOptions,
	WindowsBrowserDiscovery,
} from "../src/discovery.ts";
import {
	assertControlSuccess,
	descriptorPath,
	type AcquireRootData,
	type BrowserMode,
	type ControlResponse,
	type DaemonStatus,
	type DescriptorDaemon,
	type LeaseStatus,
	type RuntimeStatusData,
	type SessionDescriptor,
	type SessionIdentity,
	type ShelldExit,
	type ShelldServiceV1,
	WslBrowserError,
	WSL_BROWSER_PROTOCOL_VERSION,
	sessionRuntimeDir,
	sessionStateDir,
	sessionTempDir,
} from "../src/protocol.ts";
import {
	ManagedControlClient,
	type ManagedControlClientOptions,
} from "../src/shelld-client.ts";
import {
	createBrowserLaunchManager,
	type BrowserHandle,
	type BrowserLaunchManager,
} from "./windows-browser.ts";

export type ProgressUpdate = (message: string) => void;

export interface ControlClientLike {
	request<T = Record<string, unknown>>(
		fields: {
			action: "health" | "acquire-root" | "release-root" | "status" | "shutdown";
			mode?: BrowserMode;
			profile?: string;
			marker?: string;
			targetId?: string;
		},
		signal?: AbortSignal,
	): Promise<ControlResponse<T>>;
}

export interface BrowserDiscoveryLike {
	discover(
		config: WslBrowserConfig,
		mode: BrowserMode,
	): Promise<BrowserInstallation>;
}

export interface BrowserControllerOptions {
	session: SessionIdentity;
	config: WslBrowserConfig;
	service: ShelldServiceV1;
	discovery?: BrowserDiscoveryLike;
	browser?: BrowserLaunchManager;
	controlClientFactory?: (
		options: ManagedControlClientOptions,
	) => ControlClientLike;
	socketPath?: string;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	/** Used by tests to replace the WSL/PowerShell discovery probes. */
	discoveryOptions?: DiscoveryOptions;
	/** Injectable runner probe for tests; production checks uv before launch. */
	runtimeRunnerAvailable?: (runner: string) => boolean;
}

export interface ControllerStatus {
	browser?: {
		kind: BrowserInstallation["kind"];
		mode: BrowserMode;
		profileDirectory?: string;
		profileSource?: BrowserInstallation["profileSource"];
		temporary: boolean;
	};
	daemon: DescriptorDaemon;
	lease?: LeaseStatus;
	runtime?: RuntimeStatusData;
	error?: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

interface DaemonRecord {
	mode: BrowserMode;
	status: DaemonStatus;
	shell?: Awaited<ReturnType<ShelldServiceV1["start"]>>;
	client?: ControlClientLike;
	failure?: DaemonFailure;
}

interface DaemonFailure {
	code: "daemon_exited" | "daemon_start_failed" | "daemon_unavailable";
	exit?: ShelldExit;
	message: string;
}

interface StartContext {
	browser: BrowserHandle;
}

const MAX_LOG_TAIL_CHARS = 4_000;
const TRANSIENT_HEALTH_CODES = new Set([
	"daemon_starting",
	"daemon_not_ready",
	"socket_not_ready",
	"control_connection_refused",
	"control_connection_closed",
	"control_timeout",
	"cdp_connecting",
	"managed_cdp_unavailable",
	"authorization_pending",
	"authorization_required",
	"permission-blocked",
	"permission_blocked",
	"permission_pending",
]);

/**
 * Session-scoped browser controller. It owns exactly one daemon/browser pair
 * and keeps the control token private to this object.
 */
export class BrowserController {
	private readonly session: SessionIdentity;
	private readonly config: WslBrowserConfig;
	private readonly service: ShelldServiceV1;
	private readonly discovery: BrowserDiscoveryLike;
	private readonly browserManager: BrowserLaunchManager;
	private readonly controlClientFactory: (
		options: ManagedControlClientOptions,
	) => ControlClientLike;
	private readonly now: () => number;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly socketPath: string;
	private readonly descriptorFile: string;
	private readonly sessionStateDirectory: string;
	private readonly runtimeDirectory: string;
	private readonly tempDirectory: string;
	private readonly runtimeRunnerAvailable: (runner: string) => boolean;
	private daemon: DaemonRecord | undefined;
	private browser: BrowserHandle | undefined;
	private installation: BrowserInstallation | undefined;
	private lease: LeaseStatus | undefined;
	private shuttingDown = false;

	constructor(options: BrowserControllerOptions) {
		this.session = options.session;
		this.config = options.config;
		this.service = options.service;
		this.discovery =
			options.discovery ?? new WindowsBrowserDiscovery(options.discoveryOptions);
		this.browserManager = options.browser ?? createBrowserLaunchManager();
		this.controlClientFactory =
			options.controlClientFactory ??
			((clientOptions) => new ManagedControlClient(clientOptions));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? delay;
		this.runtimeRunnerAvailable =
			options.runtimeRunnerAvailable ?? defaultRuntimeRunnerAvailable;
		this.sessionStateDirectory = sessionStateDir(
			this.session.sessionKey,
			this.config.agentDir,
		);
		this.runtimeDirectory = sessionRuntimeDir(
			this.session.sessionKey,
			this.config.agentDir,
		);
		this.tempDirectory = sessionTempDir(
			this.session.sessionKey,
			this.config.agentDir,
		);
		this.socketPath =
			options.socketPath ?? join(this.sessionStateDirectory, "managed.sock");
		this.descriptorFile = descriptorPath(
			this.session.sessionKey,
			this.config.agentDir,
		);
	}

	get descriptorPath(): string {
		return this.descriptorFile;
	}

	get activeLease(): LeaseStatus | undefined {
		return this.lease
			? { ...this.lease, ownedTargetIds: [...this.lease.ownedTargetIds] }
			: undefined;
	}

	get activeMode(): BrowserMode | undefined {
		return this.lease?.mode ?? this.daemon?.mode;
	}

	get isRetained(): boolean {
		return this.lease?.retained ?? false;
	}

	async acquire(
		mode: BrowserMode,
		signal?: AbortSignal,
		onUpdate?: ProgressUpdate,
	): Promise<LeaseStatus> {
		if (this.shuttingDown) {
			throw new WslBrowserError(
				"session_shutdown",
				"browser session is shutting down",
			);
		}
		if (signal?.aborted) {
			throw new WslBrowserError("cancelled", "browser acquire was cancelled");
		}
		const previousLease = this.lease;
		if (this.lease && this.lease.mode !== mode) {
			await this.releaseLease();
			await this.stopDaemon();
		} else if (this.daemon && this.daemon.mode !== mode) {
			await this.stopDaemon();
		}

		const deadline =
			mode === "main-profile"
				? this.now() + this.config.authorizationTimeoutMs
				: undefined;
		await this.ensureDaemon(mode, signal, onUpdate, deadline);
		const daemon = this.daemon;
		const browser = this.browser;
		const installation = this.installation;
		if (
			!daemon?.client ||
			daemon.status !== "running" ||
			!browser ||
			!installation
		) {
			throw this.daemonError("daemon_unavailable");
		}
		const data = assertControlSuccess(
			await daemon.client.request<AcquireRootData>(
				{
					action: "acquire-root",
					mode,
					profile: installation.profileDirectory,
					marker: browser.marker,
				},
				signal,
			),
		);
		const root = validateAcquireRoot(data, mode);
		if (
			previousLease?.mode === mode &&
			root.rootTargetId !== previousLease.rootTargetId
		) {
			throw new WslBrowserError(
				"managed_root_changed",
				"managed daemon returned a different root target while reacquiring the active lease",
				{
					expectedRootTargetId: previousLease.rootTargetId,
					actualRootTargetId: root.rootTargetId,
				},
			);
		}
		this.lease = {
			...root,
			retained: previousLease?.mode === mode ? previousLease.retained : false,
		};
		await this.writeDescriptor();
		return this.activeLease!;
	}

	async retain(signal?: AbortSignal): Promise<LeaseStatus> {
		if (signal?.aborted) {
			throw new WslBrowserError("cancelled", "browser retain was cancelled");
		}
		if (!this.lease) {
			throw new WslBrowserError(
				"managed_no_active_lease",
				"cannot retain without an active browser lease",
			);
		}
		// Retention is an extension-local policy. The daemon lease remains
		// unchanged; agent_settled simply skips release-root while this bit is set.
		this.requireDaemon();
		this.lease.retained = true;
		await this.writeDescriptor();
		return this.activeLease!;
	}

	async release(signal?: AbortSignal): Promise<{ released: true }> {
		await this.releaseLease(signal);
		return { released: true };
	}

	async status(): Promise<ControllerStatus> {
		const daemon = this.daemon;
		const descriptorDaemon = this.descriptorDaemon();
		const status: ControllerStatus = {
			browser:
				this.installation && this.browser
					? {
							kind: this.installation.kind,
							mode: this.browser.mode,
							profileDirectory: this.installation.profileDirectory,
							profileSource: this.installation.profileSource,
							temporary: this.browser.temporary,
						}
					: undefined,
			daemon: descriptorDaemon,
			lease: this.activeLease,
		};
		if (daemon?.client && daemon.status === "running") {
			try {
				status.runtime = assertControlSuccess(
					await daemon.client.request<RuntimeStatusData>({ action: "status" }),
				);
			} catch (error) {
				if (daemon.failure) {
					status.error = {
						code: daemon.failure.code,
						message: daemon.failure.message,
						details: await this.failureDetails(daemon.failure),
					};
				} else {
					status.error = errorPayload(error);
				}
			}
		} else if (daemon?.failure) {
			status.error = {
				code: daemon.failure.code,
				message: daemon.failure.message,
				details: await this.failureDetails(daemon.failure),
			};
		}
		return status;
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const failures: string[] = [];
		const daemon = this.daemon;
		if (daemon?.client) {
			if (this.lease) {
				try {
					assertControlSuccess(
						await daemon.client.request({ action: "release-root" }),
					);
				} catch (error) {
					failures.push(formatFailure(error));
				}
				this.lease = undefined;
			}
			try {
				assertControlSuccess(await daemon.client.request({ action: "shutdown" }));
			} catch (error) {
				// A naturally exited daemon is already shut down. Preserve its
				// diagnostic rather than masking deterministic browser cleanup.
				if (!daemon.failure) failures.push(formatFailure(error));
			}
		}
		if (daemon?.shell) {
			try {
				await this.service.close(daemon.shell.shellId);
			} catch (error) {
				failures.push(formatFailure(error));
			}
		}
		if (this.browser) {
			try {
				// BrowserLaunchManager.close is a no-op for main-profile, so the
				// user's Edge process is never killed by session shutdown.
				await this.browserManager.close(this.browser);
			} catch (error) {
				failures.push(formatFailure(error));
			}
		}
		await rm(this.descriptorFile, { force: true }).catch((error) => {
			failures.push(formatFailure(error));
		});
		await rm(this.socketPath, { force: true }).catch(() => undefined);
		await rm(this.sessionStateDirectory, { recursive: true, force: true }).catch(
			(error) => {
				failures.push(formatFailure(error));
			},
		);
		this.daemon = undefined;
		this.browser = undefined;
		this.installation = undefined;
		this.lease = undefined;
		if (failures.length) {
			throw new WslBrowserError(
				"shutdown_failed",
				"one or more browser resources failed to shut down",
				{ failures },
			);
		}
	}

	private async ensureDaemon(
		mode: BrowserMode,
		signal?: AbortSignal,
		onUpdate?: ProgressUpdate,
		deadline?: number,
	): Promise<void> {
		if (this.daemon?.status === "running" && this.daemon.client) {
			await this.waitForHealth(mode, signal, onUpdate, deadline);
			return;
		}
		if (this.daemon?.failure) throw this.daemonError(this.daemon.failure.code);
		if (this.daemon?.status === "starting") {
			await this.waitForHealth(mode, signal, onUpdate, deadline);
			return;
		}

		if (
			this.config.runtime.python === "uv" &&
			!this.runtimeRunnerAvailable(this.config.runtime.python)
		) {
			throw new WslBrowserError(
				"uv_unavailable",
				"uv is required to run the pinned private browser-harness runtime",
				{ runtimeProject: this.config.runtime.project },
			);
		}
		await rm(this.socketPath, { force: true }).catch(() => undefined);
		this.daemon = { mode, status: "starting" };
		await this.writeDescriptor();
		let context: StartContext | undefined;
		try {
			const installation = await this.discovery.discover(this.config, mode);
			const browser = await this.browserManager.launch({
				installation,
				mode,
				sessionKey: this.session.sessionKey,
				config: this.config,
				deadline,
				now: this.now,
				signal,
				onUpdate,
			});
			const controlToken = randomBytes(32).toString("hex");
			context = { browser };
			const command = buildDaemonCommand({
				python: this.config.runtime.python,
				runtimeProjectRoot: this.config.runtime.project,
			});
			const shell = await this.service.start({
				command,
				cwd: this.config.runtime.project,
				name: `wsl-browser:${this.session.sessionKey}`,
				env: buildDaemonEnvironment({
					runtimeRoot: this.config.runtime.root,
					runtimeDir: this.runtimeDirectory,
					tmpDir: this.tempDirectory,
					socketPath: this.socketPath,
					controlToken,
					cdpEnvName: browser.cdpEnvName,
					cdpEnvValue: browser.cdpEnvValue,
				}),
			});
			this.installation = installation;
			this.browser = browser;
			this.daemon = {
				mode,
				status: "starting",
				shell,
				client: this.controlClientFactory({
					socketPath: this.socketPath,
					token: controlToken,
					timeoutMs: this.config.controlTimeoutMs,
				}),
			};
			void shell.settled.then(
				(exit) => this.onDaemonExit(shell.shellId, exit),
				(error) =>
					this.onDaemonExit(shell.shellId, {
						code: null,
						signal: null,
						error: error instanceof Error ? error.message : String(error),
					}),
			);
			await this.writeDescriptor();
			await this.waitForHealth(mode, signal, onUpdate, deadline);
			if (this.daemon) this.daemon.status = "running";
			await this.writeDescriptor();
		} catch (error) {
			if (this.daemon?.shell) {
				await this.service.close(this.daemon.shell.shellId).catch(() => undefined);
			}
			if (context?.browser) {
				await this.browserManager.close(context.browser).catch(() => undefined);
			}
			this.daemon = undefined;
			this.browser = undefined;
			this.installation = undefined;
			await rm(this.descriptorFile, { force: true }).catch(() => undefined);
			throw normalizeControllerError(error, mode);
		}
	}

	private async waitForHealth(
		mode: BrowserMode,
		signal?: AbortSignal,
		onUpdate?: ProgressUpdate,
		acquireDeadline?: number,
	): Promise<void> {
		const daemon = this.daemon;
		if (!daemon?.client) throw this.daemonError("daemon_unavailable");
		const timeoutMs =
			mode === "main-profile"
				? this.config.authorizationTimeoutMs
				: this.config.startupTimeoutMs;
		const deadline = acquireDeadline ?? this.now() + timeoutMs;
		let nextUpdate = 0;
		while (true) {
			if (signal?.aborted) {
				throw new WslBrowserError("cancelled", "browser acquire was cancelled");
			}
			if (this.daemon?.failure) {
				throw this.daemonError(this.daemon.failure.code);
			}
			const beforeRequest = this.now();
			if (beforeRequest >= deadline) {
				throw healthTimeoutError(
					mode,
					timeoutMs,
					this.daemon?.shell?.logFile,
					this.daemon?.shell?.shellId,
				);
			}
			let response: ControlResponse<Record<string, unknown>> | undefined;
			try {
				response = await daemon.client.request({ action: "health" }, signal);
			} catch (error) {
				if (isCancellation(error)) throw error;
				// A transient socket/authorization wait reaches the common
				// deadline branch below so main-profile reports the contract's
				// authorization_timeout rather than a generic connection error.
				if (!isTransientError(error)) {
					throw this.daemonError("daemon_unavailable", error);
				}
			}
			if (response?.ok) {
				const data = response.data;
				if (data && typeof data === "object" && !isHealthPending(data)) {
					if (acquireDeadline !== undefined && this.now() >= deadline) {
						throw healthTimeoutError(
							mode,
							timeoutMs,
							this.daemon?.shell?.logFile,
							this.daemon?.shell?.shellId,
						);
					}
					return;
				}
			} else if (response && !TRANSIENT_HEALTH_CODES.has(response.error.code)) {
				throw new WslBrowserError(
					response.error.code,
					response.error.message,
					response.error.details,
				);
			}

			const current = this.now();
			if (current >= deadline) {
				throw healthTimeoutError(
					mode,
					timeoutMs,
					this.daemon?.shell?.logFile,
					this.daemon?.shell?.shellId,
				);
			}
			if (mode === "main-profile" && onUpdate && current >= nextUpdate) {
				onUpdate(
					"Waiting for Microsoft Edge authorization: open edge://inspect/#remote-debugging, enable remote debugging, and click Allow when prompted. The same connection is held for up to 180 seconds.",
				);
				nextUpdate = current + 1_000;
			}
			await this.sleep(Math.min(this.config.pollIntervalMs, deadline - current));
		}
	}

	private async releaseLease(signal?: AbortSignal): Promise<void> {
		if (!this.lease) {
			throw new WslBrowserError(
				"managed_no_active_lease",
				"there is no active browser lease to release",
			);
		}
		const daemon = this.requireDaemon();
		assertControlSuccess(
			await daemon.client!.request({ action: "release-root" }, signal),
		);
		this.lease = undefined;
		await this.writeDescriptor();
	}

	private async stopDaemon(): Promise<void> {
		const daemon = this.daemon;
		if (!daemon) return;
		const browser = this.browser;
		const failures: string[] = [];
		if (daemon.client) {
			if (this.lease) {
				try {
					assertControlSuccess(
						await daemon.client.request({ action: "release-root" }),
					);
				} catch (error) {
					failures.push(formatFailure(error));
				}
				this.lease = undefined;
			}
			try {
				assertControlSuccess(await daemon.client.request({ action: "shutdown" }));
			} catch (error) {
				if (!daemon.failure) failures.push(formatFailure(error));
			}
		}
		if (daemon.shell) {
			await this.service.close(daemon.shell.shellId).catch((error) => {
				failures.push(formatFailure(error));
			});
		}
		if (browser) {
			await this.browserManager.close(browser).catch((error) => {
				failures.push(formatFailure(error));
			});
		}
		await rm(this.descriptorFile, { force: true }).catch(() => undefined);
		await rm(this.socketPath, { force: true }).catch(() => undefined);
		this.daemon = undefined;
		this.browser = undefined;
		this.installation = undefined;
		if (failures.length) {
			throw new WslBrowserError(
				"mode_switch_cleanup_failed",
				"could not clean up the previous browser mode",
				{ failures },
			);
		}
	}

	private requireDaemon(): DaemonRecord {
		if (!this.daemon?.client || this.daemon.status !== "running") {
			throw this.daemonError("daemon_unavailable");
		}
		if (this.daemon.failure) throw this.daemonError(this.daemon.failure.code);
		return this.daemon;
	}

	private daemonError(
		code: DaemonFailure["code"],
		cause?: unknown,
	): WslBrowserError {
		const failure = this.daemon?.failure;
		const message =
			failure?.message ??
			(code === "daemon_exited"
				? "managed browser daemon exited unexpectedly"
				: "managed browser daemon is unavailable");
		const details: Record<string, unknown> = {
			...(this.daemon?.shell
				? {
						logPath: this.daemon.shell.logFile,
						shellId: this.daemon.shell.shellId,
					}
				: {}),
			...(failure?.exit
				? {
						exitCode: failure.exit.code,
						signal: failure.exit.signal,
						processError: failure.exit.error,
					}
				: {}),
			...(cause ? { cause: formatFailure(cause) } : {}),
		};
		const logPath = this.daemon?.shell?.logFile;
		if (logPath) {
			try {
				details.logTail = readFileSync(logPath, "utf8").slice(-MAX_LOG_TAIL_CHARS);
			} catch {
				// The path remains useful when pi-shelld has already removed the log.
			}
		}
		return new WslBrowserError(code, message, details);
	}

	private descriptorDaemon(): DescriptorDaemon {
		const daemon = this.daemon;
		return {
			status: daemon?.status ?? "stopped",
			...(daemon?.shell
				? {
						pid: daemon.shell.pid,
						shellId: daemon.shell.shellId,
						logPath: daemon.shell.logFile,
						startedAt: daemon.shell.startedAt,
					}
				: {}),
			...(daemon?.failure?.exit
				? {
						exitCode: daemon.failure.exit.code,
						signal: daemon.failure.exit.signal,
					}
				: {}),
		};
	}

	private async onDaemonExit(shellId: string, exit: ShelldExit): Promise<void> {
		if (this.daemon?.shell?.shellId !== shellId) return;
		if (this.shuttingDown) return;
		this.daemon.status = "exited";
		this.daemon.failure = {
			code: "daemon_exited",
			message: `managed browser daemon exited with ${exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`}`,
			exit,
		};
		await this.writeDescriptor().catch(() => undefined);
	}

	private async failureDetails(
		failure: DaemonFailure,
	): Promise<Record<string, unknown>> {
		const details: Record<string, unknown> = {
			...(failure.exit
				? {
						exitCode: failure.exit.code,
						signal: failure.exit.signal,
						processError: failure.exit.error,
					}
				: {}),
		};
		const logPath = this.daemon?.shell?.logFile;
		if (logPath) {
			details.logPath = logPath;
			try {
				const log = await readFile(logPath, "utf8");
				details.logTail = log.slice(-MAX_LOG_TAIL_CHARS);
			} catch {
				// Keep the path even when the log was removed by pi-shelld.
			}
		}
		return details;
	}

	private async prepareSessionDirectories(): Promise<void> {
		await mkdir(this.sessionStateDirectory, { recursive: true, mode: 0o700 });
		await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
		await mkdir(this.tempDirectory, { recursive: true, mode: 0o700 });
		await Promise.all(
			[this.sessionStateDirectory, this.runtimeDirectory, this.tempDirectory].map(
				(path) => chmod(path, 0o700),
			),
		);
	}

	private async writeDescriptor(): Promise<void> {
		await this.prepareSessionDirectories();
		const descriptor: SessionDescriptor = {
			version: WSL_BROWSER_PROTOCOL_VERSION,
			sessionId: this.session.sessionId,
			sessionKey: this.session.sessionKey,
			sessionFile: this.session.sessionFile,
			socketPath: this.socketPath,
			runtimeDir: this.runtimeDirectory,
			tmpDir: this.tempDirectory,
			daemon: this.descriptorDaemon(),
			browser:
				this.installation && this.browser
					? {
							kind: this.installation.kind,
							mode: this.browser.mode,
							profileDirectory: this.installation.profileDirectory,
							temporary: this.browser.temporary,
						}
					: undefined,
			lease: this.activeLease,
			updatedAt: this.now(),
		};
		const temporary = `${this.descriptorFile}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await rename(temporary, this.descriptorFile);
	}
}

export interface DaemonCommandOptions {
	python: string;
	runtimeProjectRoot: string;
}

/** Build only the non-secret invocation for the package-private daemon. */
export function buildDaemonCommand(options: DaemonCommandOptions): string {
	const pythonInvocation =
		options.python.trim() === "uv"
			? [
					"uv",
					"run",
					"--project",
					shellQuote(options.runtimeProjectRoot),
					"--frozen",
					"python",
				]
			: [shellQuote(options.python)];
	return [...pythonInvocation, "-m", "browser_harness.daemon"].join(" ");
}

export interface DaemonEnvironmentOptions {
	runtimeRoot: string;
	runtimeDir: string;
	tmpDir: string;
	socketPath: string;
	controlToken: string;
	cdpEnvName: "BU_CDP_URL" | "BU_CDP_WS";
	cdpEnvValue: string;
}

/** Keep managed daemon credentials and session paths out of shell command text. */
export function buildDaemonEnvironment(
	options: DaemonEnvironmentOptions,
): NodeJS.ProcessEnv {
	return {
		BH_MANAGED: "1",
		BH_MANAGED_SOCKET: options.socketPath,
		BH_MANAGED_CONTROL_TOKEN: options.controlToken,
		BH_RUNTIME_DIR: options.runtimeDir,
		BH_TMP_DIR: options.tmpDir,
		PYTHONPATH: options.runtimeRoot,
		BU_NAME: undefined,
		BU_BROWSER_ID: undefined,
		BU_AUTOSPAWN: undefined,
		BU_CDP_URL:
			options.cdpEnvName === "BU_CDP_URL" ? options.cdpEnvValue : undefined,
		BU_CDP_WS:
			options.cdpEnvName === "BU_CDP_WS" ? options.cdpEnvValue : undefined,
	};
}

function validateAcquireRoot(
	value: AcquireRootData,
	mode: BrowserMode,
): AcquireRootData {
	if (
		!value ||
		typeof value !== "object" ||
		typeof value.leaseId !== "string" ||
		typeof value.rootTargetId !== "string" ||
		value.mode !== mode ||
		!Array.isArray(value.ownedTargetIds) ||
		!value.ownedTargetIds.every((id) => typeof id === "string")
	) {
		throw new WslBrowserError(
			"invalid_acquire_response",
			"managed daemon returned an invalid acquire-root payload",
		);
	}
	return {
		leaseId: value.leaseId,
		rootTargetId: value.rootTargetId,
		ownedTargetIds: [...value.ownedTargetIds],
		mode: value.mode ?? mode,
	};
}

function isHealthPending(data: Record<string, unknown>): boolean {
	return (
		data.ready === false ||
		data.healthy === false ||
		data.status === "starting" ||
		data.status === "authorizing" ||
		data.status === "authorization_pending" ||
		data.authorizationRequired === true
	);
}

function isTransientError(error: unknown): boolean {
	if (error instanceof WslBrowserError) {
		return TRANSIENT_HEALTH_CODES.has(error.code);
	}
	return true;
}

function isCancellation(error: unknown): boolean {
	return error instanceof WslBrowserError && error.code === "cancelled";
}

function normalizeControllerError(
	error: unknown,
	mode?: BrowserMode,
): WslBrowserError {
	if (
		error instanceof WslBrowserError &&
		mode === "main-profile" &&
		error.code === "browser_endpoint_timeout"
	) {
		return new WslBrowserError(
			"authorization_timeout",
			"browser authorization did not complete within 180 seconds",
			error.details,
		);
	}
	if (error instanceof WslBrowserError) return error;
	return new WslBrowserError(
		"controller_start_failed",
		error instanceof Error ? error.message : String(error),
	);
}

function errorPayload(error: unknown): {
	code: string;
	message: string;
	details?: Record<string, unknown>;
} {
	if (error instanceof WslBrowserError) {
		return { code: error.code, message: error.message, details: error.details };
	}
	return { code: "operation_failed", message: formatFailure(error) };
}

function formatFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function healthTimeoutError(
	mode: BrowserMode,
	timeoutMs: number,
	logPath?: string,
	shellId?: string,
): WslBrowserError {
	return new WslBrowserError(
		mode === "main-profile" ? "authorization_timeout" : "daemon_start_timeout",
		mode === "main-profile"
			? "browser authorization did not complete within 180 seconds"
			: `managed daemon did not become healthy within ${timeoutMs}ms`,
		{
			timeoutMs,
			...(logPath ? { logPath } : {}),
			...(shellId ? { shellId } : {}),
			...(logPath ? { logTail: readLogTail(logPath) } : {}),
		},
	);
}

function readLogTail(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").slice(-MAX_LOG_TAIL_CHARS);
	} catch {
		return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function defaultRuntimeRunnerAvailable(runner: string): boolean {
	try {
		execFileSync(runner, ["--version"], { stdio: "ignore", timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolvePromise) =>
		setTimeout(resolvePromise, milliseconds),
	);
}
