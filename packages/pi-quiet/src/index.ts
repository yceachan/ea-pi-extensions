/**
 * @zenspc/pi-quiet - Quiet Display for pi tools.
 *
 * Default once installed: Quiet Display (verb-first rows + Verb Groups).
 * Sticky Preference: ~/.pi/agent/extensions/quiet.json
 *
 * Commands:
 *   /quiet           Toggle Quiet Display
 *   /quiet on|off    Set Sticky Preference
 *   /quiet status    Show preference + config path
 *   /quiet help
 *
 * Scope: all tools when Pi exposes registerToolRenderer (built-ins + Foreign Tools).
 * Fallback without the hook: built-in read/bash/edit/write/find/grep/ls only.
 * Assistant prose and thinking still split Verb Groups.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyQuietCommand,
	formatQuietHelp,
	formatQuietStatus,
	parseQuietCommand,
} from "./command.ts";
import { CompactionIndex, shouldRetainResult } from "./compaction.ts";
import { getConfigPath, loadQuietConfig, saveQuietConfig } from "./config.ts";
import { classifyQuietTool, textLineCount } from "./classify.ts";
import { messagesFromBranch, rowsFromMessages } from "./history.ts";
import {
	resultIsImageFromUnknown,
	resultTextFromUnknown,
} from "./result-content.ts";
import { registerQuietToolRendererWrapper, registerQuietTools } from "./tools.ts";
import { toolParticipatesInQuiet } from "./tools-meta.ts";

function notify(
	ctx: ExtensionCommandContext | ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function quietExtension(pi: ExtensionAPI) {
	let enabled = loadQuietConfig().enabled;
	const configPath = getConfigPath();
	const index = new CompactionIndex();

	// Prefer Tool Renderer Wrapper (all tools + Foreign). Else built-in overrides only.
	const usingRendererHook = registerQuietToolRendererWrapper(pi, () => enabled, index);
	if (!usingRendererHook) {
		registerQuietTools(pi, () => enabled, index);
	}

	const rebuildFromSession = (ctx: ExtensionContext) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			const messages = messagesFromBranch(branch as { type?: string; message?: unknown }[]);
			index.rebuild(rowsFromMessages(messages));
		} catch {
			index.clear();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = loadQuietConfig().enabled;
		rebuildFromSession(ctx);
	});

	// Strict transcript neighbors: user/assistant prose splits Compaction Groups.
	pi.on("message_start", async (event) => {
		const role = (event.message as { role?: string } | undefined)?.role;
		if (role === "user" || role === "assistant") {
			index.addSplitter();
		}
	});

	pi.on("tool_execution_start", async (event) => {
		index.onStart({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args:
				event.args && typeof event.args === "object"
					? (event.args as Record<string, unknown>)
					: undefined,
		});
	});

	pi.on("tool_execution_end", async (event) => {
		if (!toolParticipatesInQuiet(event.toolName)) {
			index.onEnd({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				outcomeKind: event.isError ? "hard" : "success",
				isError: event.isError,
			});
			return;
		}

		const args =
			// args are not on end event; keep whatever onStart stored
			index.getRow(event.toolCallId)?.args ?? {};
		const text = resultTextFromUnknown(event.result);
		const details = (event.result as { details?: { diff?: string } } | undefined)?.details;
		const content = typeof args.content === "string" ? args.content : "";
		const outcome = classifyQuietTool({
			toolName: event.toolName,
			isPartial: false,
			isError: event.isError,
			text,
			isImage: resultIsImageFromUnknown(event.result),
			diff: details?.diff,
			contentLineCount: textLineCount(content),
		});
		if (outcome.kind === "pending") return;

		const keepResult = shouldRetainResult(event.toolName, outcome.kind);
		const resultContent = keepResult && Array.isArray((event.result as { content?: unknown })?.content)
			? ((event.result as { content: unknown[] }).content)
			: [];

		index.onEnd({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args,
			outcomeKind: outcome.kind,
			chip: outcome.chip,
			result: keepResult
				? {
						content: resultContent,
						details: (event.result as { details?: unknown })?.details,
				  }
				: undefined,
			isError: event.isError,
		});
	});

	pi.registerCommand("quiet", {
		description: usingRendererHook
			? "Toggle Quiet Display for tool rows (built-in + Foreign Tools)"
			: "Toggle Quiet Display for built-in tool rows",
		handler: async (args, ctx) => {
			const cmd = parseQuietCommand(args);
			const result = applyQuietCommand(cmd, enabled);

			if (result.kind === "help") {
				notify(ctx, formatQuietHelp(configPath), cmd.action === "unknown" ? "warning" : "info");
				return;
			}

			if (result.kind === "status") {
				notify(ctx, formatQuietStatus(enabled, configPath));
				return;
			}

			// kind === "set"
			if (result.changed) {
				if (!saveQuietConfig({ enabled: result.enabled })) {
					notify(ctx, `Failed to save Sticky Preference to ${configPath}`, "error");
					return;
				}
				enabled = result.enabled;
			}

			notify(ctx, formatQuietStatus(enabled, configPath));
		},
	});
}
