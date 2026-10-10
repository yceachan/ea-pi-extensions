/**
 * Outcome classification for Quiet Rows.
 *
 * success → Success Chip only (collapsed)
 * soft    → Soft Breakthrough (compact chip, no auto-expand body)
 * hard    → Hard Breakthrough (chip + capped tail when shown as breakthrough)
 * pending → static pending marker
 */

export type QuietOutcomeKind = "pending" | "success" | "soft" | "hard";

export type QuietOutcome = {
	kind: QuietOutcomeKind;
	/** Short chip text without leading separator. */
	chip?: string;
	/** Optional full body text for hard breakthrough tails / errors. */
	body?: string;
};

export type ExploreTool = "grep" | "find" | "ls";

/** Count non-empty lines without allocating a split array. */
export function textLineCount(text: string): number {
	if (!text) return 0;
	let count = 0;
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
			if (i > lineStart) count += 1;
			lineStart = i + 1;
		}
	}
	return count;
}

/** True if text has at least one non-empty line (early-exit scan). */
export function hasNonEmptyLine(text: string): boolean {
	if (!text) return false;
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
			if (i > lineStart) return true;
			lineStart = i + 1;
		}
	}
	return false;
}

/** Count +/− lines in a unified/display diff, ignoring file headers. */
export function diffLineStats(diff: string | undefined): { added: number; removed: number } {
	if (!diff) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

function hard(chip: string, body?: string): QuietOutcome {
	return { kind: "hard", chip, body: body ?? chip };
}

export function classifyReadOutcome(input: {
	isPartial: boolean;
	isError: boolean;
	text: string;
	isImage?: boolean;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) return hard("failed", input.text);
	if (input.isImage) return { kind: "success", chip: "image" };
	const n = textLineCount(input.text);
	return { kind: "success", chip: `${n} line${n === 1 ? "" : "s"}` };
}

export function classifyExploreOutcome(input: {
	tool: ExploreTool;
	isPartial: boolean;
	isError: boolean;
	text: string;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) return hard("failed", input.text);

	const n = textLineCount(input.text);
	const label =
		input.tool === "grep"
			? n === 1
				? "1 match"
				: `${n} matches`
			: input.tool === "find"
				? n === 1
					? "1 file"
					: `${n} files`
				: n === 1
					? "1 entry"
					: `${n} entries`;

	if (n === 0) {
		// Soft Breakthrough: kind-specific copy (search says no matches).
		if (input.tool === "grep" || input.tool === "find") {
			return { kind: "soft", chip: "no matches" };
		}
		return { kind: "soft", chip: "empty" };
	}
	return { kind: "success", chip: label };
}

export function classifyBashOutcome(input: {
	isPartial: boolean;
	isError: boolean;
	text: string;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) {
		const exit = input.text.match(/exited with code (\d+)/i);
		const chip = exit ? `exit ${exit[1]}` : "failed";
		return hard(chip, input.text);
	}
	// Clean bash success omits the chip (including empty stdout Soft classification).
	if (!hasNonEmptyLine(input.text)) return { kind: "soft" };
	return { kind: "success" };
}

export function classifyEditOutcome(input: {
	isPartial: boolean;
	isError: boolean;
	diff?: string;
	text: string;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) return hard("failed", input.text);
	const { added, removed } = diffLineStats(input.diff);
	return { kind: "success", chip: `+${added} -${removed}` };
}

export function classifyWriteOutcome(input: {
	isPartial: boolean;
	isError: boolean;
	contentLineCount: number;
	text: string;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) return hard("failed", input.text);
	const n = input.contentLineCount;
	return { kind: "success", chip: `${n} line${n === 1 ? "" : "s"}` };
}

/** Generic Kind Formatter outcomes for Foreign Tools. */
export function classifyForeignOutcome(input: {
	isPartial: boolean;
	isError: boolean;
	text: string;
	isImage?: boolean;
}): QuietOutcome {
	if (input.isPartial) return { kind: "pending" };
	if (input.isError) return hard("failed", input.text);
	if (input.isImage) return { kind: "success" };
	if (!hasNonEmptyLine(input.text)) return { kind: "soft", chip: "empty" };
	// Omit uninteresting (ok) chip on Foreign success.
	return { kind: "success" };
}

export type ClassifyToolInput = {
	toolName: string;
	isPartial: boolean;
	isError: boolean;
	text: string;
	isImage?: boolean;
	diff?: string;
	/** write content line count from args */
	contentLineCount?: number;
};

/** Dispatch to the per-tool classifier for Quiet built-ins. */
export function classifyQuietTool(input: ClassifyToolInput): QuietOutcome {
	switch (input.toolName) {
		case "read":
			return classifyReadOutcome({
				isPartial: input.isPartial,
				isError: input.isError,
				text: input.text,
				isImage: input.isImage,
			});
		case "bash":
			return classifyBashOutcome({
				isPartial: input.isPartial,
				isError: input.isError,
				text: input.text,
			});
		case "edit":
			return classifyEditOutcome({
				isPartial: input.isPartial,
				isError: input.isError,
				diff: input.diff,
				text: input.text,
			});
		case "write":
			return classifyWriteOutcome({
				isPartial: input.isPartial,
				isError: input.isError,
				contentLineCount: input.contentLineCount ?? 0,
				text: input.text,
			});
		case "grep":
		case "find":
		case "ls":
			return classifyExploreOutcome({
				tool: input.toolName,
				isPartial: input.isPartial,
				isError: input.isError,
				text: input.text,
			});
		default:
			return classifyForeignOutcome({
				isPartial: input.isPartial,
				isError: input.isError,
				text: input.text,
				isImage: input.isImage,
			});
	}
}
