import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	reapStaleState,
	setExitNotifier,
	setSessionFile,
	shutdownShells,
	withRegistryLock,
} from "./shells";
import { registerShellDaemonTool } from "./tool";
import {
	clearShellFooterStatus,
	registerTuiMonitor,
	syncShellFooterStatus,
} from "./tui";

/**
 * pi-shelld extension entry.
 *
 * R2 rule: the extension factory MUST NOT start any background resources
 * (processes, sockets, file watchers, timers). Factories may run in
 * invocations that never start a session. All background work is deferred to
 * `session_start` and tool callbacks. Tool registration is safe at load: the
 * tool touches session state only at execute time.
 *
 * T7 lifecycle (ADR-0001): two states — `running` / `to close` (derived),
 * `stop` vs `close`, exit notifications to the agent, and session-boundary
 * sweeps: `session_start` reaps stale state (killing orphaned trees),
 * `session_shutdown` closes everything. Both run under the registry lock so
 * they serialize with in-flight tool calls. See `src/shells.ts` and
 * `src/tool.ts`.
 *
 * T4 TUI monitor: registered at load (shortcut `alt+s`, `/shelld` command,
 * footer-status sync on shell_daemon calls — see `src/tui.ts`);
 * `session_start` seeds the ⭕shell footer entry, `session_shutdown` clears it.
 */
export default function (pi: ExtensionAPI) {
	registerShellDaemonTool(pi);
	registerTuiMonitor(pi);

	// Exit notification (ADR-0001): when a shell becomes to close (natural
	// exit or user stop), tell the agent to read the tail output and close
	// it. `deliverAs: "steer"` lands the message before the agent's next LLM
	// call mid-turn; no `triggerTurn` — an idle agent learns at its next turn.
	setExitNotifier((message) =>
		pi.sendMessage(
			{ customType: "shelld", content: message, display: true },
			{ deliverAs: "steer" },
		),
	);

	pi.on("session_start", async (_event, ctx) => {
		// Pin the session file FIRST: `stateDir()` derives the registry from
		// it, so the reap below must read the session-scoped dir — pi does
		// not expose PI_SESSION_FILE to the extension process, only to bash
		// tool executions. Without this, every session shares ~/.pi/shelld
		// and a new session's reap kills another session's live shells
		// (bug #11).
		setSessionFile(ctx.sessionManager.getSessionFile());
		await withRegistryLock(() => reapStaleState());
		syncShellFooterStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Re-pin on the way out (covers runtimes that never fired
		// session_start, e.g. some ephemeral/edge invocations) so the sweep
		// targets the session-scoped dir, never the shared fallback.
		setSessionFile(ctx.sessionManager.getSessionFile());
		// ADR-0001: nothing survives the session — sweep everything.
		await withRegistryLock(() => shutdownShells());
		clearShellFooterStatus(ctx);
	});
}
