import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import {
	loadConfig,
	type LoadConfigOptions,
	type WslBrowserConfig,
} from "./config.ts";
import { BrowserLifecycle, type LifecycleController } from "./lifecycle.ts";
import {
	defaultAgentDir,
	formatToolError,
	isBrowserMode,
	isLifecycleAction,
	resolveSessionIdentity,
	type BrowserMode,
	type LifecycleAction,
	type SessionIdentity,
	WSL_BROWSER_TOOL_NAME,
	WslBrowserError,
} from "./protocol.ts";
import { resolveShelldService } from "./shelld-client.ts";
import {
	BrowserController,
	type BrowserControllerOptions,
	ProgressUpdate,
} from "../controller/controller.ts";

export interface WslBrowserToolDetails {
	action: LifecycleAction;
	mode?: BrowserMode;
	status: string;
	[key: string]: unknown;
}

export interface WslBrowserToolRuntimeOptions {
	extensionDir?: string;
	service?: BrowserControllerOptions["service"];
	config?: WslBrowserConfig;
	loadConfig?: (options: LoadConfigOptions) => WslBrowserConfig;
	createController?: (options: BrowserControllerOptions) => LifecycleController;
	controllerOptions?: Omit<
		BrowserControllerOptions,
		"service" | "config" | "session"
	>;
}

export interface WslBrowserToolRuntime {
	/** `StringEnum` uses TUnsafe; keep the public tool handle shallow for TS 6. */
	tool: ToolDefinition<TSchema, WslBrowserToolDetails>;
	sessionStart(ctx: ExtensionContext): void;
	agentSettled(ctx: ExtensionContext): Promise<void>;
	sessionShutdown(ctx: ExtensionContext): Promise<void>;
	getLifecycle(ctx: ExtensionContext): BrowserLifecycle;
}

const parameters = Type.Object(
	{
		action: StringEnum(["acquire", "retain", "release", "status"]),
		mode: Type.Optional(
			StringEnum(["headless", "headed-tmp-profile", "main-profile"]),
		),
	},
	{ additionalProperties: false },
);

type WslBrowserParams = {
	action: LifecycleAction;
	mode?: BrowserMode;
};

const DESCRIPTION =
	"Manage the current Pi session's owned Edge/Chrome browser target lease. Acquire before using pi-wsl-browser run; retain before waiting for user interaction; release when finished. This tool never selects an arbitrary daemon or user tab.";

/** Build the extension tool and lifecycle event hooks without starting resources. */
export function createWslBrowserToolRuntime(
	pi: ExtensionAPI,
	options: WslBrowserToolRuntimeOptions = {},
): WslBrowserToolRuntime {
	let lifecycle: BrowserLifecycle | undefined;
	let lifecycleKey: string | undefined;
	let activeAgentDir: string | undefined;

	const getCurrentLifecycle = (ctx: ExtensionContext): BrowserLifecycle => {
		const identity = contextIdentity(ctx);
		if (lifecycle && lifecycleKey === identity.sessionKey) return lifecycle;
		if (lifecycle && lifecycleKey !== identity.sessionKey) {
			throw new WslBrowserError(
				"session_mismatch",
				"pi-wsl-browser cannot switch the managed lease between Pi sessions",
			);
		}
		const config =
			options.config ??
			(options.loadConfig ?? loadConfig)({
				extensionDir: options.extensionDir,
				cwd: ctx.cwd,
			});
		const service = options.service ?? resolveShelldService(pi);
		lifecycle = new BrowserLifecycle({
			createController:
				options.createController ??
				((controllerOptions) => new BrowserController(controllerOptions)),
			service,
			config,
			session: identity,
			controllerOptions: options.controllerOptions,
		});
		lifecycleKey = identity.sessionKey;
		activeAgentDir = config.agentDir;
		return lifecycle;
	};

	const tool: WslBrowserToolRuntime["tool"] = {
		name: WSL_BROWSER_TOOL_NAME,
		label: "WSL Browser",
		description: DESCRIPTION,
		promptSnippet:
			"Acquire and release the current session's managed browser lease",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: WslBrowserParams, signal, onUpdate, ctx) {
			if (!isLifecycleAction(params.action)) {
				throw new WslBrowserError(
					"invalid_action",
					`unsupported wsl_browser action: ${String(params.action)}`,
				);
			}
			if (params.mode !== undefined && !isBrowserMode(params.mode)) {
				throw new WslBrowserError(
					"invalid_mode",
					`unsupported browser mode: ${String(params.mode)}`,
				);
			}
			try {
				const current = getCurrentLifecycle(ctx);
				const mode = params.mode ?? "headless";
				let data: object;
				switch (params.action) {
					case "acquire": {
						const update: ProgressUpdate = (message) => {
							onUpdate?.({
								content: [{ type: "text", text: message }],
								details: {
									action: "acquire",
									mode,
									status: "waiting",
								},
							});
						};
						data = await current.acquire(mode, signal, update);
						break;
					}
					case "retain":
						data = await current.retain(signal);
						break;
					case "release":
						data = await current.release(signal);
						break;
					case "status":
						data = await current.status();
						break;
				}
				const details: WslBrowserToolDetails = {
					action: params.action,
					...(params.action === "acquire" ? { mode } : {}),
					status: params.action === "status" ? "ok" : params.action,
					...data,
				};
				setUiStatus(ctx, params.action === "release" ? undefined : details);
				return successResult(details);
			} catch (error) {
				// Tool execution failures are thrown for Pi's normal error path, but
				// the message remains machine-readable for the user and harness logs.
				const structured = formatToolError(error);
				if (error instanceof WslBrowserError) {
					throw new WslBrowserError(error.code, structured, error.details);
				}
				throw new Error(structured);
			}
		},
	};

	return {
		tool,
		sessionStart(_ctx) {},
		async agentSettled(ctx) {
			if (!lifecycle) return;
			try {
				if (lifecycleKey !== contextIdentity(ctx).sessionKey) return;
				await lifecycle.autoRelease();
			} catch (error) {
				await logLifecycleCleanupFailure(
					activeAgentDir ?? defaultAgentDir(),
					"agent_settled",
					error,
				);
			}
		},
		async sessionShutdown(ctx) {
			if (!lifecycle) return;
			let matchesLifecycle = false;
			try {
				matchesLifecycle = lifecycleKey === contextIdentity(ctx).sessionKey;
				if (!matchesLifecycle) return;
				await lifecycle.shutdown();
			} catch (error) {
				await logLifecycleCleanupFailure(
					activeAgentDir ?? defaultAgentDir(),
					"session_shutdown",
					error,
				);
			} finally {
				if (matchesLifecycle) {
					lifecycle = undefined;
					lifecycleKey = undefined;
					activeAgentDir = undefined;
				}
			}
		},
		getLifecycle: getCurrentLifecycle,
	};
}

export function registerWslBrowserTool(
	pi: ExtensionAPI,
	options: WslBrowserToolRuntimeOptions = {},
): WslBrowserToolRuntime {
	const runtime = createWslBrowserToolRuntime(pi, options);
	pi.registerTool(runtime.tool);
	return runtime;
}

function contextIdentity(ctx: ExtensionContext): SessionIdentity {
	const sessionManager = ctx.sessionManager as {
		getSessionFile?: () => string;
	};
	const sessionFile = sessionManager?.getSessionFile?.();
	return sessionFile
		? resolveSessionIdentity({ sessionFile })
		: resolveSessionIdentity();
}

async function logLifecycleCleanupFailure(
	agentDir: string,
	sourceEvent: "agent_settled" | "session_shutdown",
	error: unknown,
): Promise<void> {
	const errorPayload =
		error instanceof WslBrowserError
			? error.toJSON()
			: {
					code: "operation_failed",
					message: error instanceof Error ? error.message : String(error),
				};
	const logDirectory = join(agentDir, ".pi-wsl-browser");
	const record = {
		timestamp: new Date().toISOString(),
		level: "error",
		event: "lifecycle_cleanup_failed",
		sourceEvent,
		error: errorPayload,
	};
	try {
		await mkdir(logDirectory, { recursive: true, mode: 0o700 });
		await appendFile(
			join(logDirectory, "log.txt"),
			`${JSON.stringify(record)}\n`,
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
	} catch {
		// Event cleanup and its diagnostics are both best-effort.
	}
}

function successResult(
	details: WslBrowserToolDetails,
): AgentToolResult<WslBrowserToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({ ok: true, data: details }, null, 2),
			},
		],
		details,
	};
}

function setUiStatus(
	ctx: ExtensionContext,
	value: WslBrowserToolDetails | undefined,
): void {
	const setStatus = (
		ctx.ui as { setStatus?: (key: string, value?: string) => void }
	).setStatus;
	if (!setStatus) return;
	setStatus(
		"wsl-browser",
		value
			? `browser ${value.status}${value.mode ? ` (${value.mode})` : ""}`
			: undefined,
	);
}
