/**
 * Quiet Row string builders (no TUI / theme dependency).
 * Verb-first headers, parenthetical Success Chips, basename targets.
 */

import type { QuietOutcome } from "./classify.ts";
import type { QuietToolName, VerbGroupKind } from "./tools-meta.ts";
import {
	FOREIGN_KIND_EMOJI,
	VERB_GROUP_KIND_EMOJI,
	isQuietToolName,
	verbGroupKind,
} from "./tools-meta.ts";

/** Last N lines shown on Hard Breakthrough auto-expand. */
export const HARD_FAILURE_TAIL_LINES = 12;

/** Max visible characters for bash command on the call line. */
export const MAX_COMMAND_DISPLAY = 80;

/** Max visible characters for a Foreign Tool arg peek. */
export const MAX_ARG_PEEK_DISPLAY = 60;

/** Max visible characters for a search pattern on the row. */
export const MAX_PATTERN_DISPLAY = 40;

/** Kind Emoji for Quiet built-ins (singleton rows). */
export const KIND_EMOJI: Record<QuietToolName, string> = {
	read: "📖",
	bash: "💻",
	edit: "✏️",
	write: "📝",
	grep: "🔍",
	find: "🔎",
	ls: "📂",
};

/** Priority arg keys for Generic Kind Formatter peeks. */
export const ARG_PEEK_PRIORITY_KEYS = [
	"tool",
	"name",
	"path",
	"query",
	"command",
	"pattern",
	"id",
	"url",
	"message",
	"prompt",
] as const;

export function kindEmoji(tool: string): string {
	if (isQuietToolName(tool)) return KIND_EMOJI[tool];
	if (!tool) return "";
	return FOREIGN_KIND_EMOJI;
}

export function shortenPath(path: string, home: string): string {
	if (!path) return path;
	if (home && (path === home || path.startsWith(`${home}/`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** Last path segment for collapsed Quiet Row targets. */
export function basenameTarget(path: string): string {
	if (!path) return path;
	if (path === "." || path === "~") return path;
	const trimmed = path.replace(/\/+$/u, "");
	if (!trimmed) return path;
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (slash < 0) return trimmed;
	const base = trimmed.slice(slash + 1);
	return base || trimmed;
}

/**
 * Display targets for a set of paths in one Verb Group.
 * Basename by default; parent/basename (home-shortened) when basename collides.
 */
export function displayTargets(paths: readonly string[], home: string): string[] {
	const bases = paths.map((p) => basenameTarget(p || "."));
	const counts = new Map<string, number>();
	for (const b of bases) counts.set(b, (counts.get(b) ?? 0) + 1);

	return paths.map((raw, i) => {
		const path = raw || ".";
		const base = bases[i]!;
		if ((counts.get(base) ?? 0) <= 1) return base;

		const trimmed = path.replace(/\/+$/u, "") || path;
		const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
		if (slash <= 0) return shortenPath(path, home);

		const parent = trimmed.slice(0, slash);
		const parentBase = basenameTarget(parent);
		const candidate = `${parentBase}/${base}`;
		// If still ambiguous among collisions, fall back to home-shortened full path.
		const collisionIndexes: number[] = [];
		for (let j = 0; j < bases.length; j++) {
			if (bases[j] === base) collisionIndexes.push(j);
		}
		const candidates = collisionIndexes.map((j) => {
			const p = (paths[j] || ".").replace(/\/+$/u, "") || ".";
			const s = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
			if (s <= 0) return basenameTarget(p);
			return `${basenameTarget(p.slice(0, s))}/${bases[j]!}`;
		});
		const candCounts = new Map<string, number>();
		for (const c of candidates) candCounts.set(c, (candCounts.get(c) ?? 0) + 1);
		if ((candCounts.get(candidate) ?? 0) <= 1) return candidate;
		return shortenPath(path, home);
	});
}

function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 3) return text.slice(0, max);
	return `${text.slice(0, max - 3)}...`;
}

export type CallArgs = Record<string, unknown>;

/** True when an arg key looks secret-bearing and must not appear in peeks. */
export function isSecretArgKey(key: string): boolean {
	const n = key.toLowerCase();
	if (
		n === "token" ||
		n === "key" ||
		n === "secret" ||
		n === "password" ||
		n === "authorization" ||
		n === "cookie" ||
		n === "auth" ||
		n === "api_key" ||
		n === "apikey"
	) {
		return true;
	}
	if (n.endsWith("_token") || n.endsWith("_secret") || n.endsWith("_password")) return true;
	if (n.endsWith("_key") || n.includes("password") || n.includes("secret")) return true;
	if (n.includes("token") || n.includes("authorization") || n.includes("cookie")) return true;
	return false;
}

function formatPeekValue(value: unknown, home: string): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.replace(/\s+/g, " ").trim();
		if (!trimmed) return undefined;
		const shortened =
			trimmed.startsWith("/") || trimmed.startsWith("~") || (home && trimmed.startsWith(home))
				? shortenPath(trimmed, home)
				: trimmed;
		return truncateMiddle(shortened, MAX_ARG_PEEK_DISPLAY);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return truncateMiddle(String(value), MAX_ARG_PEEK_DISPLAY);
	}
	return undefined;
}

/**
 * Short arg peek for the Generic Kind Formatter.
 * Priority keys first, else first safe top-level stringish value.
 */
export function formatArgPeek(args: CallArgs, home: string): string | undefined {
	for (const key of ARG_PEEK_PRIORITY_KEYS) {
		if (!(key in args) || isSecretArgKey(key)) continue;
		const peek = formatPeekValue(args[key], home);
		if (peek !== undefined) return peek;
	}
	// Prefer string fields, then number/boolean, so counts like `limit` do not hide labels.
	let fallback: string | undefined;
	for (const [key, value] of Object.entries(args)) {
		if (isSecretArgKey(key)) continue;
		if (typeof value === "string") {
			const peek = formatPeekValue(value, home);
			if (peek !== undefined) return peek;
			continue;
		}
		if (fallback === undefined) {
			fallback = formatPeekValue(value, home);
		}
	}
	return fallback;
}

function pathArg(args: CallArgs): string {
	return typeof args.path === "string" && args.path ? args.path : "";
}

function targetPath(args: CallArgs, displayTarget?: string): string {
	if (displayTarget !== undefined) return displayTarget;
	const p = pathArg(args);
	return p ? basenameTarget(p) : "...";
}

function looksLikePath(value: string): boolean {
	if (!value) return false;
	if (value.startsWith("/") || value.startsWith("~") || value.startsWith("./") || value.startsWith("../")) {
		return true;
	}
	if (value.includes("/") || value.includes("\\")) return true;
	return false;
}

function quotePattern(pattern: string): string {
	const trimmed = pattern.replace(/\s+/g, " ").trim();
	const body = truncateMiddle(trimmed, MAX_PATTERN_DISPLAY);
	return `"${body.replace(/"/g, '\\"')}"`;
}

/** Present/past verb for a tool call (edit/write differ within EditFile). */
export function verbForTool(tool: string, running: boolean): string {
	switch (tool) {
		case "read":
			return running ? "Reading" : "Read";
		case "grep":
		case "find":
			return running ? "Searching" : "Searched";
		case "ls":
			return running ? "Listing" : "Listed";
		case "bash":
			// Bash uses $ prompt style; verb unused on singleton call line.
			return running ? "Running" : "Ran";
		case "edit":
			return running ? "Editing" : "Edited";
		case "write":
			return running ? "Writing" : "Wrote";
		default:
			return running ? "Calling" : "Called";
	}
}

/** Verb for a Verb Group Header (always past - groups are settled-only). */
export function verbForKind(kind: VerbGroupKind, running = false): string {
	let past: string;
	let present: string;
	switch (kind) {
		case "file":
			past = "Read";
			present = "Reading";
			break;
		case "search":
			past = "Searched";
			present = "Searching";
			break;
		case "dir":
			past = "Listed";
			present = "Listing";
			break;
		case "command":
			past = "Ran";
			present = "Running";
			break;
		case "editFile":
			past = "Edited";
			present = "Editing";
			break;
		case "other":
			past = "Called";
			present = "Calling";
			break;
	}
	return running ? present : past;
}

/** Noun for a Verb Group Header, pluralized by count. */
export function nounForKind(kind: VerbGroupKind, count: number): string {
	let one: string;
	let many: string;
	switch (kind) {
		case "file":
		case "editFile":
			one = "file";
			many = "files";
			break;
		case "search":
			one = "pattern";
			many = "patterns";
			break;
		case "dir":
			one = "dir";
			many = "dirs";
			break;
		case "command":
			one = "command";
			many = "commands";
			break;
		case "other":
			one = "tool";
			many = "tools";
			break;
	}
	return count === 1 ? one : many;
}

export type FormatCallOptions = {
	/** When true, use present-tense verbs (running singleton). */
	running?: boolean;
	/** Collision-resolved path display (basename or parent/base). */
	displayTarget?: string;
};

/**
 * Verb-first call summary without Kind Emoji or Success Chip.
 * Bash uses `$ cmd` (no Ran/Running on the line).
 */
export function formatCallSummary(
	tool: string,
	args: CallArgs,
	home: string,
	options: FormatCallOptions = {},
): string {
	const running = Boolean(options.running);
	const verb = verbForTool(tool, running);

	switch (tool) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			return `$ ${truncateMiddle(command.replace(/\s+/g, " ").trim(), MAX_COMMAND_DISPLAY)}`;
		}
		case "read": {
			const target = targetPath(args, options.displayTarget);
			// Range chip is a Success Chip concern when settled; while running show path only.
			// Requested range is part of the call summary when present (Grok-like).
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = typeof args.offset === "number" ? args.offset : 1;
				if (typeof args.limit === "number") {
					return `${verb} ${target || "..."} (${start}-${start + args.limit - 1})`;
				}
				return `${verb} ${target || "..."} (${start}-)`;
			}
			return `${verb} ${target || "..."}`;
		}
		case "edit":
			return `${verb} ${targetPath(args, options.displayTarget)}`;
		case "write":
			return `${verb} ${targetPath(args, options.displayTarget)}`;
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return `${verb} ${quotePattern(pattern)}`;
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = pathArg(args) || ".";
			// Path-like find targets stay unquoted; globs/patterns stay unquoted or quoted by shape.
			if (pattern) {
				if (looksLikePath(pattern)) {
					const display =
						options.displayTarget ?? basenameTarget(pattern);
					return `${verb} ${display}`;
				}
				// globs and free text
				if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
					return `${verb} ${truncateMiddle(pattern, MAX_PATTERN_DISPLAY)}`;
				}
				return `${verb} ${quotePattern(pattern)}`;
			}
			const display =
				options.displayTarget ?? (path ? basenameTarget(path) : ".");
			return `${verb} ${display}`;
		}
		case "ls": {
			const path = pathArg(args) || ".";
			const display = options.displayTarget ?? basenameTarget(path);
			return `${verb} ${display}`;
		}
		default: {
			const peek = formatArgPeek(args, home);
			return peek ? `${verb} ${tool} ${peek}` : `${verb} ${tool}`;
		}
	}
}

export function capFailureTail(
	text: string,
	maxLines: number = HARD_FAILURE_TAIL_LINES,
): string {
	const lines = text.replace(/\s+$/u, "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(-maxLines).join("\n");
}

/** Parenthetical Success Chip fragment, or empty string when omitted. */
export function formatChipParen(chip: string | undefined): string {
	if (!chip) return "";
	return ` (${chip})`;
}

/**
 * Extra result lines after the call line.
 * Success/soft chips live on the call line (parenthetical) - not here.
 * Hard breakthrough appends a capped error tail when expanded/auto-shown.
 */
export function formatQuietResultLines(
	outcome: QuietOutcome,
	expanded: boolean,
): string[] {
	if (outcome.kind === "pending") return [];
	if (outcome.kind === "hard" && expanded && outcome.body) {
		const tail = capFailureTail(outcome.body);
		return tail ? tail.split("\n") : [];
	}
	return [];
}

/** Singleton Quiet Row call line: Kind Emoji + verb-first summary + optional chip. */
export function formatSingletonCallLine(
	tool: string,
	args: CallArgs,
	home: string,
	options: FormatCallOptions & { chip?: string } = {},
): string {
	const emoji = kindEmoji(tool);
	const summary = formatCallSummary(tool, args, home, options);
	let chip = options.chip;
	// Read with a requested range already embeds (start-end); drop redundant line-count chips.
	if (
		tool === "read" &&
		chip &&
		(args.offset !== undefined || args.limit !== undefined) &&
		/\blines?$/u.test(chip)
	) {
		chip = undefined;
	}
	let line = summary;
	if (chip) {
		const paren = formatChipParen(chip);
		if (!summary.endsWith(paren)) {
			line = `${summary}${paren}`;
		}
	}
	return emoji ? `${emoji} ${line}` : line;
}

/** Group Header: Kind Emoji + verb + count + noun (for example `📖 Read 3 files`). */
export function formatGroupHeader(kind: VerbGroupKind, count: number): string {
	const emoji = VERB_GROUP_KIND_EMOJI[kind];
	const verb = verbForKind(kind, false);
	const noun = nounForKind(kind, count);
	const label = `${verb} ${count} ${noun}`;
	return emoji ? `${emoji} ${label}` : label;
}

/**
 * Member Bullet target fragment with the verb stripped
 * (the Group Header already supplies kind + count).
 */
export function formatMemberSummary(
	tool: string,
	args: CallArgs,
	home: string,
	options: FormatCallOptions = {},
): string {
	switch (tool) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			return `$ ${truncateMiddle(command.replace(/\s+/g, " ").trim(), MAX_COMMAND_DISPLAY)}`;
		}
		case "read": {
			const target = targetPath(args, options.displayTarget);
			if (args.offset !== undefined || args.limit !== undefined) {
				const start = typeof args.offset === "number" ? args.offset : 1;
				if (typeof args.limit === "number") {
					return `${target} (${start}-${start + args.limit - 1})`;
				}
				return `${target} (${start}-)`;
			}
			return target;
		}
		case "edit":
		case "write":
		case "ls":
			return targetPath(args, options.displayTarget);
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			return quotePattern(pattern);
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = pathArg(args) || ".";
			if (pattern) {
				if (looksLikePath(pattern)) {
					return options.displayTarget ?? basenameTarget(pattern);
				}
				if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
					return truncateMiddle(pattern, MAX_PATTERN_DISPLAY);
				}
				return quotePattern(pattern);
			}
			return options.displayTarget ?? basenameTarget(path);
		}
		default: {
			// Foreign: header already says tools; bullet is name + optional peek.
			const peek = formatArgPeek(args, home);
			return peek ? `${tool} ${peek}` : tool;
		}
	}
}

/** One Member Bullet under a Group Header. */
export function formatMemberBullet(summary: string, chip?: string): string {
	if (chip) return `  • ${summary}${formatChipParen(chip)}`;
	return `  • ${summary}`;
}

/** Resolve Verb Group Kind for a tool name (re-export convenience). */
export function groupKindForTool(tool: string): VerbGroupKind {
	return verbGroupKind(tool);
}
