/**
 * pi-exit — exit pi by typing /exit, /quit, :q, :q!, :wq (or :wq!).
 *
 * Normally the only ways out of the TUI are Ctrl+C / Ctrl+D (or the built-in
 * `/quit`). This extension lets the user quit by typing one of the familiar
 * vim/shell exit commands and sending it as a prompt:
 *
 *   /exit, /quit, :q, :q!, :wq, :wq!
 *
 * How it works:
 *   1. `/exit` is registered as a real command (commands are dispatched before
 *      the input event, so it shuts down deterministically without an LLM call).
 *   2. The `input` event catches everything else (:q, :q!, :wq, :wq!, and
 *      /exit|/quit as a fallback in modes where commands aren't intercepted)
 *      and handles it with a clean shutdown — no LLM round trip.
 *   3. A `pi_exit` tool lets the agent itself request shutdown, e.g. when the
 *      user asks in natural language ("退出吧", "quit please").
 *
 * `ctx.shutdown()` is graceful: it emits session_shutdown so state is saved,
 * and in interactive mode it is deferred until the agent is idle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Commands that trigger a clean shutdown when sent as a prompt. */
const EXIT_TEXT_PATTERNS: RegExp[] = [
	// Slash commands allow trailing arguments ("/exit now", "/quit please").
	/^\/exit(\s|$)/i,
	/^\/quit(\s|$)/i,
	// Vim-style commands match exactly (case-insensitive, optional whitespace).
	/^:q$/i,
	/^:q!$/i,
	/^:wq$/i,
	/^:wq!$/i,
];

function isExitText(text: string): boolean {
	const trimmed = text.trim();
	return EXIT_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export default function (pi: ExtensionAPI) {
	// 1. `/exit` as a real command (dispatched before the input event).
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (aliases: /quit, :q, :q!, :wq, :wq!)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Exiting pi...", "info");
			ctx.shutdown();
		},
	});

	// 2. Intercept the rest as raw prompts.
	pi.on("input", async (event, ctx) => {
		// Don't act on messages injected by other extensions.
		if (event.source === "extension") return { action: "continue" };
		if (!isExitText(event.text)) return { action: "continue" };

		ctx.ui.notify("Exiting pi...", "info");
		ctx.shutdown();
		return { action: "handled" };
	});

	// 3. Tool the LLM can call to exit on request.
	pi.registerTool({
		name: "pi_exit",
		label: "Exit Pi",
		description:
			"Exit and close the pi agent application cleanly. Call this when the user asks to exit, quit, or close the agent — e.g. they typed /exit, /quit, :q, :q!, :wq, or said 退出/再见/quit in natural language. Shutdown happens after the current turn completes.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ctx.ui.notify("Exiting pi...", "info");
			ctx.shutdown();
			return {
				content: [
					{
						type: "text",
						text: "Shutdown requested — pi will exit after this turn. Goodbye!",
					},
				],
				details: {},
			};
		},
	});
}
