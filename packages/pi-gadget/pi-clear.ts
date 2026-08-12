/**
 * pi-clear — /clear command
 *
 * Archives the current session and starts a brand-new, empty conversation.
 *
 * Usage:
 *   /clear           命名并归档对话，然后清空并开始全新 session
 *   /clear [name]    同上，可选 [name] 为归档会话命名
 *                     （例如 `/clear 完成了登录模块`，之后在
 *                      `/resume` / `pi -r` 中一眼可辨）
 *
 * How it works:
 *   The command calls `ctx.newSession()` with the current session file as the
 *   parent. This runs the exact same shutdown/save sequence as a normal exit
 *   (abort + persist the active turn, emit `session_shutdown`, save the JSONL
 *   session file), then boots an empty session. The old conversation stays on
 *   disk and remains resumable — nothing is deleted.
 *
 *   With an optional name argument, the outgoing session gets a `session_info`
 *   entry before teardown, so `/resume` shows a meaningful title for the
 *   archive instead of a raw timestamp.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "/clear [name] : 命名并归档对话，然后清空并开始全新 session",
		handler: async (args, ctx) => {
			// Session file of the conversation being archived (undefined in
			// ephemeral --no-session mode).
			const sessionFile = ctx.sessionManager.getSessionFile();

			// A session with no entries has nothing to archive; switching anyway
			// would just churn out empty session files.
			if (ctx.sessionManager.getEntries().length === 0) {
				ctx.ui.notify(
					"Nothing to clear — the session is already empty.",
					"info",
				);
				return;
			}

			// Optional archive name: `/clear 重构了鉴权模块`. Recorded as a
			// session_info entry on the outgoing session before it is saved, so
			// the archive shows up with a readable title in /resume and pi -r.
			const archiveName = args.trim();
			if (archiveName) {
				pi.setSessionName(archiveName);
			}

			// newSession() tears the current session down exactly like a normal
			// exit (session_shutdown + persist), then starts an empty session.
			// `parentSession` links the new session's header back to the archive.
			const result = await ctx.newSession({
				parentSession: sessionFile,
				// async is required: withSession must return Promise<void>. All
				// post-switch work here is synchronous (notify on the fresh ctx).
				// pi-lens-ignore: async-noise
				withSession: async (freshCtx) => {
					const archived = sessionFile ?? "(in-memory session, not saved)";
					freshCtx.ui.notify(
						archiveName
							? `Cleared. Archived "${archiveName}" → ${archived}. Fresh conversation started.`
							: `Cleared. Archived ${archived}. Fresh conversation started.`,
						"info",
					);
				},
			});

			if (result.cancelled) {
				// Another extension vetoed the switch via session_before_switch.
				ctx.ui.notify("Clear cancelled", "info");
			}
		},
	});
}
