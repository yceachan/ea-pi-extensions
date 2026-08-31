import { createConnection, type Socket } from "node:net";
import {
	encodeControlRequest,
	MANAGED_CONTROL_META,
	parseControlResponse,
	type ControlResponse,
	type ManagedControlAction,
	type ManagedControlRequest,
	WslBrowserError,
} from "./protocol.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SHELLD_SERVICE_CHANNEL, type ShelldServiceV1 } from "./protocol.ts";

export interface ManagedControlClientOptions {
	socketPath: string;
	token: string;
	timeoutMs?: number;
	connect?: (path: string) => Socket;
}

export interface ManagedControlRequestFields {
	action: ManagedControlAction;
	mode?: ManagedControlRequest["mode"];
	profile?: string;
	marker?: string;
	targetId?: string;
}

/** One-request-per-connection client for the private managed daemon socket. */
export class ManagedControlClient {
	private readonly socketPath: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly connectSocket: (path: string) => Socket;

	constructor(options: ManagedControlClientOptions) {
		this.socketPath = options.socketPath;
		this.token = options.token;
		this.timeoutMs = options.timeoutMs ?? 5_000;
		this.connectSocket = options.connect ?? ((path) => createConnection(path));
	}

	request<T = Record<string, unknown>>(
		fields: ManagedControlRequestFields,
		signal?: AbortSignal,
	): Promise<ControlResponse<T>> {
		const request: ManagedControlRequest = {
			meta: MANAGED_CONTROL_META,
			token: this.token,
			...fields,
		};
		return this.requestRaw<T>(request, signal);
	}

	private requestRaw<T>(
		request: ManagedControlRequest,
		signal?: AbortSignal,
	): Promise<ControlResponse<T>> {
		return new Promise<ControlResponse<T>>((resolvePromise, rejectPromise) => {
			let socket: Socket | undefined;
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let buffer = "";

			const cleanup = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				socket?.removeAllListeners();
				socket?.destroy();
			};
			const settleError = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				rejectPromise(error instanceof Error ? error : new Error(String(error)));
			};
			const settleResponse = (response: ControlResponse<T>) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolvePromise(response);
			};
			const onAbort = () =>
				settleError(
					new WslBrowserError("cancelled", "managed daemon request was cancelled"),
				);

			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(
				() =>
					settleError(
						new WslBrowserError(
							"control_timeout",
							`managed daemon did not answer within ${this.timeoutMs}ms`,
							{ socketPath: this.socketPath, action: request.action },
						),
					),
				this.timeoutMs,
			);
			try {
				socket = this.connectSocket(this.socketPath);
			} catch (error) {
				settleError(error);
				return;
			}
			const onData = (chunk: Buffer | string) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline).trim();
				if (!line) {
					settleError(
						new WslBrowserError(
							"invalid_control_response",
							"managed daemon returned an empty response",
						),
					);
					return;
				}
				try {
					settleResponse(parseControlResponse<T>(JSON.parse(line)));
				} catch (error) {
					settleError(error);
				}
			};
			socket.on("data", onData);
			socket.once("error", settleError);
			socket.once("close", () => {
				if (!settled) {
					settleError(
						new WslBrowserError(
							"control_connection_closed",
							"managed daemon closed the control connection without a response",
							{ socketPath: this.socketPath, action: request.action },
						),
					);
				}
			});
			socket.once("connect", () => {
				if (!settled) socket?.write(encodeControlRequest(request));
			});
		});
	}
}

/** Discover pi-shelld lazily through the stable event channel. */
export function resolveShelldService(pi: ExtensionAPI): ShelldServiceV1 {
	let service: ShelldServiceV1 | undefined;
	pi.events.emit(SHELLD_SERVICE_CHANNEL, {
		provide(candidate: ShelldServiceV1) {
			service ??= candidate;
		},
	});
	if (!service) {
		throw new WslBrowserError(
			"shelld_unavailable",
			"pi-shelld service v1 is unavailable; load @yceachan/pi-shelld and reload",
		);
	}
	return service;
}
