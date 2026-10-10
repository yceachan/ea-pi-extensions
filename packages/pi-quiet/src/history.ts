/**
 * Rebuild CompactionRows from session messages (pure).
 * User/assistant messages become splitters; toolResult messages become settled rows.
 */

import { classifyQuietTool, textLineCount } from "./classify.ts";
import {
	type CompactionOutcomeKind,
	type CompactionRow,
	shouldRetainResult,
} from "./compaction.ts";
import {
	resultIsImageFromContent,
	resultTextFromContent,
} from "./result-content.ts";
import { toolParticipatesInQuiet } from "./tools-meta.ts";

type LooseContent =
	| string
	| Array<{ type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;

type LooseMessage = {
	role?: string;
	content?: LooseContent;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

function collectToolArgs(messages: readonly LooseMessage[]): Map<string, Record<string, unknown>> {
	const args = new Map<string, Record<string, unknown>>();
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				args.set(
					block.id,
					block.arguments && typeof block.arguments === "object"
						? (block.arguments as Record<string, unknown>)
						: {},
				);
			}
		}
	}
	return args;
}

/**
 * Build ordered CompactionRows from LLM/session messages in transcript order.
 */
export function rowsFromMessages(messages: readonly unknown[]): CompactionRow[] {
	const loose = messages as LooseMessage[];
	const argById = collectToolArgs(loose);
	const rows: CompactionRow[] = [];
	let splitterSeq = 0;

	for (const msg of loose) {
		const role = msg.role;
		if (role === "user" || role === "assistant") {
			splitterSeq += 1;
			rows.push({
				toolCallId: `hist-split-${splitterSeq}`,
				toolName: "",
				quiet: false,
				status: "settled",
				splitter: true,
			});
			continue;
		}

		if (role !== "toolResult") continue;
		const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
		if (!toolCallId || !toolName) continue;

		const args = argById.get(toolCallId) ?? {};
		const text = resultTextFromContent(msg.content);
		const details = msg.details as { diff?: string } | undefined;
		const content =
			typeof args.content === "string" ? args.content : "";

		const outcome = classifyQuietTool({
			toolName,
			isPartial: false,
			isError: Boolean(msg.isError),
			text,
			isImage: resultIsImageFromContent(msg.content),
			diff: details?.diff,
			contentLineCount: textLineCount(content),
		});

		const outcomeKind: CompactionOutcomeKind | undefined =
			outcome.kind === "success" || outcome.kind === "soft" || outcome.kind === "hard"
				? outcome.kind
				: undefined;

		const keepResult = shouldRetainResult(toolName, outcomeKind);
		const contentBlocks = keepResult && Array.isArray(msg.content) ? msg.content : [];
		rows.push({
			toolCallId,
			toolName,
			quiet: toolParticipatesInQuiet(toolName),
			status: "settled",
			outcomeKind,
			chip: outcome.chip,
			args,
			result: keepResult
				? {
						content: contentBlocks,
						details: msg.details,
				  }
				: undefined,
			isError: Boolean(msg.isError),
		});
	}

	return rows;
}

/** Extract AgentMessages from a session branch (message entries only). */
export function messagesFromBranch(entries: readonly { type?: string; message?: unknown }[]): unknown[] {
	const out: unknown[] = [];
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message) out.push(entry.message);
	}
	return out;
}
