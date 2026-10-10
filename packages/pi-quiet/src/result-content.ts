/** Shared tool-result content helpers (no TUI). */

export function resultTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const block = content.find(
		(c) => c && typeof c === "object" && (c as { type?: string }).type === "text",
	) as { text?: string } | undefined;
	return block?.text ?? "";
}

export function resultIsImageFromContent(content: unknown): boolean {
	if (!content || !Array.isArray(content)) return false;
	return content.some(
		(c) => c && typeof c === "object" && (c as { type?: string }).type === "image",
	);
}

export function resultTextFromUnknown(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	return resultTextFromContent((result as { content?: unknown }).content);
}

export function resultIsImageFromUnknown(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	return resultIsImageFromContent((result as { content?: unknown }).content);
}
