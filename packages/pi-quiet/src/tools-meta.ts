/** Built-in tool kinds with specialized Kind Formatters. */

export const QUIET_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
] as const;

export type QuietToolName = (typeof QUIET_TOOL_NAMES)[number];

/**
 * Semantic bucket for Verb Groups (not the raw tool name).
 * Explore kinds fold; Command / EditFile stay singletons.
 */
export type VerbGroupKind =
	| "file"
	| "search"
	| "dir"
	| "command"
	| "editFile"
	| "other";

/** Shared Kind Emoji for Foreign Tools (Generic Kind Formatter). */
export const FOREIGN_KIND_EMOJI = "🧩";

/** Canonical Kind Emoji for a Verb Group Kind (Group Headers). */
export const VERB_GROUP_KIND_EMOJI: Record<VerbGroupKind, string> = {
	file: "📖",
	search: "🔍",
	dir: "📂",
	command: "💻",
	editFile: "✏️",
	other: FOREIGN_KIND_EMOJI,
};

export function isQuietToolName(name: string): name is QuietToolName {
	return (QUIET_TOOL_NAMES as readonly string[]).includes(name);
}

/** Map a tool name to its Verb Group Kind. */
export function verbGroupKind(toolName: string): VerbGroupKind {
	switch (toolName) {
		case "read":
			return "file";
		case "grep":
		case "find":
			return "search";
		case "ls":
			return "dir";
		case "bash":
			return "command";
		case "edit":
		case "write":
			return "editFile";
		default:
			return "other";
	}
}

/** True when settled success|soft rows of this kind may join a Verb Group. */
export function verbGroupJoins(kind: VerbGroupKind): boolean {
	return kind === "file" || kind === "search" || kind === "dir" || kind === "other";
}

/**
 * Whether Foreign Tools join Quiet Display / Verb Groups.
 * Off until a Tool Renderer Wrapper is registered (Pi registerToolRenderer).
 * Built-ins always participate via registerTool overrides when the hook is absent.
 */
let foreignToolsQuiet = false;

export function setForeignToolsQuiet(enabled: boolean): void {
	foreignToolsQuiet = enabled;
}

export function foreignToolsQuietEnabled(): boolean {
	return foreignToolsQuiet;
}

/** True when this tool name paints Quiet Rows and may join Verb Groups. */
export function toolParticipatesInQuiet(name: string): boolean {
	if (!name) return false;
	if (isQuietToolName(name)) return true;
	return foreignToolsQuiet;
}
