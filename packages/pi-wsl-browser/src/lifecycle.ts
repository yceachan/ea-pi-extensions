import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WslBrowserConfig } from "./config.ts";
import {
	type BrowserMode,
	type LeaseStatus,
	type SessionIdentity,
	resolveSessionIdentity,
} from "./protocol.ts";
import type {
	BrowserControllerOptions,
	ControllerStatus,
	ProgressUpdate,
} from "../controller/controller.ts";

export interface LifecycleController {
	acquire(
		mode: BrowserMode,
		signal?: AbortSignal,
		onUpdate?: ProgressUpdate,
	): Promise<LeaseStatus>;
	retain(signal?: AbortSignal): Promise<LeaseStatus>;
	release(signal?: AbortSignal): Promise<{ released: true }>;
	status(): Promise<ControllerStatus>;
	shutdown(): Promise<void>;
	readonly activeLease?: LeaseStatus;
	readonly isRetained: boolean;
}

export interface LifecycleFactoryOptions {
	createController(options: BrowserControllerOptions): LifecycleController;
	service: BrowserControllerOptions["service"];
	config: WslBrowserConfig;
	session: SessionIdentity;
	controllerOptions?: Omit<
		BrowserControllerOptions,
		"service" | "config" | "session"
	>;
}

/**
 * Serializes lifecycle calls and owns the agent-settled policy. A retained
 * lease is deliberately not touched by autoRelease; session shutdown always
 * reaches the controller regardless of retention.
 */
export class BrowserLifecycle {
	private readonly controller: LifecycleController;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(options: LifecycleFactoryOptions) {
		this.controller = options.createController({
			...options.controllerOptions,
			service: options.service,
			config: options.config,
			session: options.session,
		});
	}

	get activeLease(): LeaseStatus | undefined {
		return this.controller.activeLease;
	}

	get isRetained(): boolean {
		return this.controller.isRetained;
	}

	get rawController(): LifecycleController {
		return this.controller;
	}

	acquire(
		mode: BrowserMode,
		signal?: AbortSignal,
		onUpdate?: ProgressUpdate,
	): Promise<LeaseStatus> {
		return this.enqueue(() => this.controller.acquire(mode, signal, onUpdate));
	}

	retain(signal?: AbortSignal): Promise<LeaseStatus> {
		return this.enqueue(() => this.controller.retain(signal));
	}

	release(signal?: AbortSignal): Promise<{ released: true }> {
		return this.enqueue(() => this.controller.release(signal));
	}

	status(): Promise<ControllerStatus> {
		return this.enqueue(() => this.controller.status());
	}

	/** Called by Pi's `agent_settled` event. */
	autoRelease(): Promise<void> {
		return this.enqueue(async () => {
			if (!this.controller.activeLease || this.controller.isRetained) return;
			await this.controller.release();
		});
	}

	/** Called by Pi's `session_shutdown` event; retention never bypasses this. */
	shutdown(): Promise<void> {
		return this.enqueue(() => this.controller.shutdown());
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation, operation);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}

export function createBrowserLifecycle(
	options: LifecycleFactoryOptions,
): BrowserLifecycle {
	return new BrowserLifecycle(options);
}

/** Resolve a session identity from a Pi context without choosing a daemon. */
export function sessionIdentityFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): SessionIdentity {
	return resolveSessionIdentity({
		sessionFile: ctx.sessionManager.getSessionFile(),
	});
}
