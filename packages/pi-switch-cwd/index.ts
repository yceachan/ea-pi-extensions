/**
 * pi-switch-cwd — /cwd command
 *
 * Switches the session's working directory — the conversation continues
 * in the new directory, with the session file relocated there.
 *
 * Usage:
 *   /cwd                show the current cwd
 *   /cwd <path>         switch to <path> (relative to the current cwd,
 *                       "~" expands to $HOME; created with mkdir -p if
 *                       it does not exist yet)
 *
 * How it works:
 *   pi has no in-place cwd mutation API — cwd-bound services (bash/read/
 *   write tools, context files, skills, settings) are rebuilt only when
 *   the session runtime is replaced. /cwd therefore relocates the session:
 *
 *   1. waitForIdle() — never replaces a session mid-run
 *   2. build the relocated session file from in-memory state: header `cwd`
 *      rewritten, same session id, full history preserved (the JSONL may
 *      not exist on disk yet — pi flushes it lazily after agent turns)
 *   3. ctx.switchSession(newFile) — the runtime reads the header cwd,
 *      rebuilds all cwd-bound services for the new directory
 *   4. only after a successful switch: delete the old session file
 *
 *   The session "follows the work": it never accumulates fork copies, and
 *   it shows up in /resume only under the directory it currently lives in.
 *   A session_before_switch veto or any failure leaves the old file intact.
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	buildMovedSessionFile,
	completeDirectories,
	resolveTargetPath,
	shortenPath,
} from "./cwd-utils.ts";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function (pi: ExtensionAPI) {
	// Base cwd for argument completion. getArgumentCompletions has no ctx,
	// so track it here: session_start fires with the right ctx.cwd whenever
	// the runtime (re)starts — including after a /cwd switch, which restarts
	// the extension instance.
	let currentCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		currentCwd = ctx.cwd;
	});

	pi.registerCommand("cwd", {
		description:
			"/cwd [path] : switch the session working directory (session file moves with it)",
		getArgumentCompletions: (prefix) => completeDirectories(prefix, currentCwd),
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const arg = args.trim();

			if (!arg) {
				ctx.ui.notify(`Current cwd: ${shortenPath(cwd)}`, "info");
				return;
			}

			const target = resolveTargetPath(arg, cwd);

			// Same directory — nothing to do.
			if (target === cwd) {
				ctx.ui.notify(`Already in ${shortenPath(cwd)}`, "info");
				return;
			}

			// Validate or create the target before touching the session.
			try {
				if (!statSync(target).isDirectory()) {
					ctx.ui.notify(`Not a directory: ${shortenPath(target)}`, "error");
					return;
				}
			} catch {
				try {
					mkdirSync(target, { recursive: true });
				} catch (err) {
					ctx.ui.notify(
						`Could not create directory ${shortenPath(target)}: ${errMessage(err)}`,
						"error",
					);
					return;
				}
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				// getSessionFile() is undefined in ephemeral (--no-session) mode.
				ctx.ui.notify("Cannot switch cwd: session is not persisted.", "error");
				return;
			}

			// Never replace the session runtime while the agent is running.
			await ctx.waitForIdle();

			// Build the relocated session file from the in-memory session state
			// (header cwd rewritten, same id/entries; the JSONL may not exist on
			// disk yet — pi flushes it lazily after agent turns).
			let destFile: string;
			try {
				destFile = buildMovedSessionFile(
					// SessionHeader has no index signature; intentional structural read.
					ctx.sessionManager.getHeader() as unknown as Record<string, unknown>,
					ctx.sessionManager.getEntries(),
					target,
					getAgentDir(),
					basename(sessionFile),
				);
			} catch (err) {
				ctx.ui.notify(`Cannot switch cwd: ${errMessage(err)}`, "error");
				return;
			}

			const result = await ctx.switchSession(destFile, {
				// Runs on the fresh replacement-session ctx; old ctx is stale from
				// here on (only plain captured strings are used). The resume flow
				// shows "Resumed session" as its own status line right after the
				// switch, which would overwrite an immediate notify — defer so the
				// "Switched" status lands after it.
				// pi-lens-ignore: async-noise (withSession must return Promise<void>)
				withSession: async (freshCtx) => {
					const message = `Switched: ${shortenPath(cwd)} → ${shortenPath(target)}`;
					setTimeout(() => freshCtx.ui.notify(message, "info"), 200);
				},
			});

			if (result.cancelled) {
				// Another extension vetoed via session_before_switch — the old
				// session file is untouched and still active.
				ctx.ui.notify("cwd switch cancelled — session left in place.", "info");
				return;
			}

			// Switch succeeded: the conversation now lives in the new cwd's
			// session dir. Remove the old file (captured path string — safe
			// after the runtime swap).
			rmSync(sessionFile, { force: true });
		},
	});
}
