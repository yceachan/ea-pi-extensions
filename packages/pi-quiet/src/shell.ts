/**
 * Tool Shell Background tokens (Stock-matching strip under renderShell: "self").
 */

import type { QuietOutcome } from "./classify.ts";

/**
 * Quiet Tool Shell padding (tighter than Stock's default of 1).
 * Keeps pending/success/error strip colors with less vertical chrome.
 */
export const TOOL_SHELL_PADDING = 0;

export type ToolShellBg = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/** Quiet outcome → Tool Shell Background token (Soft shares success). */
export function toolShellBgForQuietOutcome(kind: QuietOutcome["kind"]): ToolShellBg {
	switch (kind) {
		case "pending":
			return "toolPendingBg";
		case "hard":
			return "toolErrorBg";
		case "soft":
		case "success":
			return "toolSuccessBg";
		default: {
			const _exhaustive: never = kind;
			return _exhaustive;
		}
	}
}

/** Stock path: same rules as ToolExecutionComponent bgFn. */
export function toolShellBgForStock(isPartial: boolean, isError: boolean): ToolShellBg {
	if (isPartial) return "toolPendingBg";
	if (isError) return "toolErrorBg";
	return "toolSuccessBg";
}
