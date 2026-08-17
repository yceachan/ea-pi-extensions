/**
 * pi-cite-wslpath — single-file gadget: turn a native (WSL) path into a
 * Windows-Terminal-openable markdown hyperlink.
 *
 * Why: pi runs inside WSL, so tool/agent output that cites files with
 * `file:///home/...`, `file:///tmp/...`, or `file:///mnt/c/...` URIs cannot be
 * opened from Windows Terminal — its `file://` whitelist only accepts
 * Windows-accessible forms:
 *
 *   - `file:///C:/...`                (drvfs: /mnt/<drive> IS the Windows drive)
 *   - `file://wsl.localhost/<distro>/...`  (9P bridge, WT >= 1.17)
 *
 * The `pi_cite_wslpath` tool lets the model convert any native path to a
 * clickable markdown link directly, without hard-coding the conversion rules
 * in the system prompt. Paths arrive as a `paths` array, so one tool call
 * converts any number of paths — citing several files costs a single request
 * instead of N.
 *
 * The tool returns exactly one form per path — a markdown `[label](uri)` —
 * because that is the only form that survives the pi rendering pipeline and
 * Windows Terminal's hyperlink handling at any width: pi's Markdown renderer
 * turns it into an OSC 8 hyperlink, which hides the URL on screen (nothing to
 * wrap) and registers it as a link the terminal reconstructs across soft wraps.
 * Raw OSC 8 escape sequences and bare URIs are deliberately NOT returned: a
 * bare URI is long, wraps on narrow screens, and Windows Terminal's URL
 * auto-detection cannot join the fragments, so it becomes a dead link.
 *
 * agent_end force-check: after every agent run, the delivered assistant text
 * is scanned for two forms Windows Terminal cannot open: `file://` URIs
 * with a non-drive first segment (empty-host `file:///` or
 * `file://localhost`, i.e. /home, /tmp, /mnt, ...), and markdown links
 * whose target is a bare WSL-native absolute POSIX path (`[label](/home/...)`)
 * — pi renders those, but Windows Terminal has no scheme to resolve them.
 * When any leak, the extension reports it
 * (detect-and-tell; the delivered text itself is left untouched): a one-line
 * summary via notify, plus a chat custom message with converted links — the
 * `>[!note]` callout below — rendered by the same Markdown→OSC 8 pipeline as
 * the chat body, so every link is clickable regardless of terminal width.
 * Quoted examples are skipped (code spans/fences and `...` ellipsis forms),
 * so citing the guideline text itself does not trip the check.
 *
 * The tool also verifies each path exists on disk before citing, so a
 * misspelled filename is flagged at cite time instead of producing a link
 * that cannot be opened.
 *
 * In Windows Terminal the user opens hyperlinks with Ctrl+click.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

/** `/mnt/<drive>[/rest]` — the WSL auto-mount of a Windows drive. */
const WSL_MNT_RE = /^\/mnt\/([a-z])(?:\/(.*))?$/i;

/** Windows drive-letter form, already usable as a file URI (`C:\...`). */
const WIN_DRIVE_RE = /^[a-z]:[\\/]/i;

/** UNC form for the WSL 9P bridge (`\\wsl.localhost\...` or `\\wsl$\...`). */
const UNC_WSL_RE = /^(?:\\\\|\/\/)wsl(?:\.localhost|\$)?[\\/]/i;

export function isWslEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "linux" && !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export interface CiteOptions {
	/** Base directory for relative paths. Defaults to process.cwd(). */
	cwd?: string;
	/** WSL distro name for the wsl.localhost host. Defaults to $WSL_DISTRO_NAME. */
	distro?: string;
	/** Force WSL conversion on/off instead of auto-detecting the environment. */
	wsl?: boolean;
	/** Display text for the hyperlink. Defaults to the (home-shortened) path. */
	label?: string;
}

/** Shorten home-prefixed absolute paths to ~/... for display. */
export function shortenLabel(path: string, home: string = homedir()): string {
	if (home && (path === home || path.startsWith(`${home}/`))) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** Escape a label for safe use inside a markdown link. */
function escapeMarkdownLabel(label: string): string {
	return label.replace(/[[\]]/g, "\\$&");
}

/**
 * Percent-encode a path for a file:// URI WITHOUT encoding non-ASCII
 * characters. Windows' wsl.localhost bridge decodes %XX byte-wise (ANSI-style),
 * so percent-encoded UTF-8 (e.g. %E5%A4%8D) arrives mojibake'd and the file is
 * reported as not found, while raw UTF-8 passes through the bridge intact.
 * Only ASCII characters that would break URI parsing (space, %, #, ?, ...)
 * are escaped — those decode back byte-for-byte correctly (verified: %20 opens).
 */
export function escapeUriPath(path: string): string {
	// RFC 3986 unreserved + sub-delims + ':' '@' '/' — everything allowed in a
	// path (segments plus the '/' separator). '#' and '?' are excluded on
	// purpose: they would be parsed as fragment/query and truncate the path.
	const SAFE = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;
	let out = "";
	for (const ch of path) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (cp > 0x7f || SAFE.test(ch)) {
			out += ch;
		} else {
			out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
		}
	}
	return out;
}

/**
 * Convert a native path to a Windows-Terminal-openable file URI.
 *
 * WSL rules:
 *   /mnt/<d>/rest  -> file:///<D>:/rest          (drvfs is the real Windows drive)
 *   /abs/path      -> file://wsl.localhost/<distro>/abs/path
 * Pass-throughs (idempotent):
 *   C:\..., file://, \\wsl.localhost\... stay usable as-is.
 * Outside WSL the standard file:// URI is returned.
 */
export function toWindowsFileUri(
	nativePath: string,
	options: CiteOptions = {},
): string {
	const trimmed = nativePath.trim();

	// Already a URI: return unchanged (idempotent).
	if (/^file:\/\//i.test(trimmed)) return trimmed;

	const wsl = options.wsl ?? isWslEnvironment();

	// Windows drive form — normalize to a URI, independent of WSL.
	if (WIN_DRIVE_RE.test(trimmed)) {
		const normalized = trimmed.replaceAll("\\", "/");
		return `file:///${escapeUriPath(normalized)}`;
	}

	// UNC wsl bridge form — normalize to the wsl.localhost URI. The first
	// path segment already carries the distro name, so nothing is prepended.
	if (UNC_WSL_RE.test(trimmed)) {
		const normalized = trimmed
			.replace(/^(?:\\\\|\/\/)wsl(?:\.localhost|\$)?[\\/]/i, "/")
			.replaceAll("\\", "/");
		return `file://wsl.localhost/${escapeUriPath(normalized).replace(/^\/+/, "")}`;
	}

	const cwd = options.cwd ?? process.cwd();
	const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);

	if (wsl) {
		const mnt = WSL_MNT_RE.exec(abs);
		if (mnt) {
			const drive = mnt[1].toUpperCase();
			const rest = mnt[2] ?? "";
			return `file:///${drive}:/${escapeUriPath(rest)}`;
		}
		const distro = options.distro ?? process.env.WSL_DISTRO_NAME ?? "";
		if (distro) {
			return `file://wsl.localhost/${distro}${escapeUriPath(abs)}`;
		}
		// WSL without a known distro name: the wsl.localhost URI would be
		// malformed, so fall back to the standard file URI.
		return pathToFileURL(abs).href;
	}

	return pathToFileURL(abs).href;
}

export interface CiteResult {
	/** Windows-openable file URI. */
	uri: string;
	/** Markdown link form (pi chat renders this as an OSC 8 hyperlink). */
	markdown: string;
	/** Display label used for the hyperlink. */
	label: string;
}

/** Full conversion: native path -> { uri, markdown, label }. */
export function citeWslpath(
	nativePath: string,
	options: CiteOptions = {},
): CiteResult {
	const uri = toWindowsFileUri(nativePath, options);
	const label = options.label ?? shortenLabel(nativePath);
	return {
		uri,
		markdown: `[${escapeMarkdownLabel(label)}](${uri})`,
		label,
	};
}

/**
 * `file://` URI forms Windows Terminal refuses to open: empty host
 * (`file:///`) or `file://localhost` with a first path segment that is not a
 * drive letter. `file:///C:/...` is the accepted Windows form; `file:///home/...`,
 * `file:///tmp/...`, `file:///mnt/...` all point at Linux-side paths.
 * `#`/`?` stop the match (fragment/query are excluded from the path, matching
 * `escapeUriPath`, which escapes them).
 */
const WINDOWS_BROKEN_FILE_URI_RE =
	/file:\/\/(?:localhost)?\/(?!\/?[A-Za-z]:)[^\s\x00-\x1f"'<>`),;:#?\u3000-\u303f\uff00-\uffef)\]}]+/g;

/**
 * Markdown link whose target is a bare WSL-native absolute POSIX path
 * (`[label](/home/...md)`). The lead-negative lookahead excludes URI-ish
 * forms (`//host`, `/#anchor`, `/?query`) so only real filesystem paths are
 * matched; the trailing character class stops at the closing `)`.
 */
const NATIVE_PATH_MARKDOWN_LINK_RE =
	/\[([^\]]*)\]\((\/(?![/#?])[^\s())\]]+)\)/g;

/** A link/URI in delivered text that Windows Terminal cannot open. */
export interface BrokenLinkHit {
	/** The raw matched fragment (a file:// URI or a markdown link). */
	raw: string;
	/** The WSL-native path recovered from the fragment. */
	nativePath: string;
	/** Original markdown label when the hit was a `[label](...)` link. */
	label?: string;
}

/** Minimal structural view of a message, enough to scan assistant text. */
interface MessageLike {
	role?: string;
	content?: string | readonly { type?: string; text?: string }[];
}

/**
 * Find links/URIs in text that Windows Terminal would refuse to open: broken
 * `file://` URIs and markdown links targeting bare WSL-native POSIX paths.
 * Deduplicated by recovered path, first-seen order. Example quotes are
 * skipped: hits inside backtick code spans or fenced code blocks (they render
 * as plain text, not links), and ones ending in an ellipsis (`...`/`…`) —
 * guideline texts quote exactly these forms.
 */
export function findWindowsBrokenLinks(text: string): BrokenLinkHit[] {
	const found: BrokenLinkHit[] = [];
	const seen = new Set<string>();
	const hits: { index: number; hit: BrokenLinkHit }[] = [];
	for (const match of text.matchAll(WINDOWS_BROKEN_FILE_URI_RE)) {
		hits.push({
			index: match.index ?? 0,
			hit: {
				raw: match[0],
				nativePath: leakedFileUriToPath(match[0]) ?? match[0],
			},
		});
	}
	for (const match of text.matchAll(NATIVE_PATH_MARKDOWN_LINK_RE)) {
		hits.push({
			index: match.index ?? 0,
			hit: { raw: match[0], nativePath: match[2], label: match[1] },
		});
	}
	hits.sort((a, b) => a.index - b.index);
	let lineStart = 0;
	let inFence = false;
	for (const { index, hit } of hits) {
		// Advance the line state up to the match's line (fence toggling).
		while (true) {
			const lineEnd = text.indexOf("\n", lineStart);
			const end = lineEnd === -1 ? text.length : lineEnd;
			if (index <= end) break;
			if (isFenceLine(text.slice(lineStart, end))) inFence = !inFence;
			lineStart = end + 1;
		}
		if (inFence) continue;
		const before = text.slice(lineStart, index);
		let backticks = 0;
		for (const ch of before) {
			if (ch === "`") backticks++;
		}
		if (backticks % 2 === 1) continue; // inside an inline code span
		if (matchFragmentsEndInEllipsis(hit.raw)) continue;
		if (seen.has(hit.nativePath)) continue;
		seen.add(hit.nativePath);
		found.push(hit);
	}
	return found;
}

/** Whether the raw fragment ends in an ellipsis (guideline-text quote form). */
function matchFragmentsEndInEllipsis(raw: string): boolean {
	return raw.endsWith("...") || raw.endsWith("…");
}

/**
 * `file://` URIs in text that Windows Terminal would refuse to open — the
 * raw matched fragments (kept for compatibility; prefer {@link findWindowsBrokenLinks}).
 */
export function findWindowsBrokenFileUris(text: string): string[] {
	const out: string[] = [];
	for (const hit of findWindowsBrokenLinks(text)) {
		if (/^file:\/\//i.test(hit.raw)) out.push(hit.raw);
	}
	return out;
}

/** Fence opener/closer line (``` or ~~~, optionally with a language tag). */
function isFenceLine(line: string): boolean {
	return /^(`{3,}|~{3,})/.test(line.trim());
}

/**
 * Whether the input is a native POSIX-style path — the only form checkable
 * from WSL. Already-URI, Windows-drive and UNC forms are passed through.
 */
function isNativePath(input: string): boolean {
	return (
		!/^file:\/\//i.test(input) &&
		!WIN_DRIVE_RE.test(input) &&
		!UNC_WSL_RE.test(input)
	);
}

/** Recover the native path from a leaked `file://` URI (percent-decoding). */
export function leakedFileUriToPath(uri: string): string | undefined {
	const match = /^file:\/\/(?:localhost)?(\/.*)$/.exec(uri);
	if (!match) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

/**
 * Scan the assistant message texts of an agent run for links Windows
 * Terminal cannot open (broken `file://` URIs and native-POSIX-path
 * markdown links; deduplicated by recovered path). This feeds the
 * agent_end force-check.
 */
export function findDeliveredBrokenLinks(
	messages: readonly MessageLike[],
): BrokenLinkHit[] {
	const found: BrokenLinkHit[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string" || !message.content) continue;
		for (const block of message.content) {
			if (block.type !== "text" || !block.text) continue;
			for (const hit of findWindowsBrokenLinks(block.text)) {
				if (seen.has(hit.nativePath)) continue;
				seen.add(hit.nativePath);
				found.push(hit);
			}
		}
	}
	return found;
}

// pi-lens-ignore: high-fan-out
export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi_cite_wslpath",
		label: "Cite WSL Path",
		description:
			"Convert a native (WSL) file path into a Windows-Terminal-openable markdown hyperlink. " +
			"pi runs in WSL, so plain file:///home/... or file:///mnt/c/... links cannot be opened " +
			"from the terminal; this tool rewrites them to Windows-accessible URIs " +
			"(/mnt/<drive> -> file:///<DRIVE>:/..., other paths -> file://wsl.localhost/<distro>/...). " +
			"Each path returns exactly one markdown link ([label](uri)) — paste it verbatim into " +
			"your reply; pi renders it as a clickable hyperlink at any terminal width. " +
			"The user opens it in Windows Terminal with Ctrl+click. " +
			"Call this whenever you cite or print file paths in your reply — " +
			"batch them into a single `paths` array instead of one call per path.",
		promptSnippet:
			"pi_cite_wslpath: native paths (batch `paths` array) -> Windows-openable markdown links (Ctrl+click opens in Windows Terminal)",
		promptGuidelines: [
			"When citing file paths in replies, call pi_cite_wslpath first and paste its returned markdown link verbatim into chat text.",
			"Never emit raw file:///home/..., file:///tmp/... or file:///mnt/... links — Windows Terminal rejects them.",
			"Batch multiple file paths into one pi_cite_wslpath call (paths array) instead of one call per path.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
		}),
		// pi-lens-ignore: long-parameter-list
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const sections = params.paths.map((path, index) => {
				const { markdown } = citeWslpath(path);
				const parts = [`${index + 1}. ${markdown}`];
				if (isNativePath(path)) {
					const abs = isAbsolute(path)
						? resolve(path)
						: resolve(process.cwd(), path);
					if (!existsSync(abs)) {
						parts.push(
							"   ! not found on disk — double-check the path/filename before citing",
						);
					}
				}
				return parts.join("\n");
			});
			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: {},
			};
		},
	});

	// Force-check the delivered reply for links Windows Terminal cannot open.
	// Detect-and-tell: the delivered text is left untouched; the report is a
	// one-line notify summary plus a chat custom message whose converted links
	// go through the same Markdown -> OSC 8 pipeline as the chat body, so they
	// stay clickable at any terminal width (the URL is hidden on screen —
	// nothing wraps — and the terminal reconstructs the link across soft wraps).
	//
	// Timing: agent_end fires while the run is still active (isStreaming is
	// true until agent_settled), so pi.sendMessage there would be queued via
	// steer() instead of rendered — and would even trigger an extra LLM
	// continuation. Detection therefore happens on agent_end (it carries the
	// run's messages) and delivery on agent_settled (isStreaming is false,
	// so the custom message is appended and rendered immediately). Only the
	// most recent detection is reported; a later run overwrites the pending
	// report before it is sent.
	let pendingLinks: string[] | undefined;

	pi.on("agent_end", (event) => {
		if (!isWslEnvironment()) return;
		const leaked = findDeliveredBrokenLinks(event.messages);
		if (leaked.length === 0) {
			pendingLinks = undefined;
			return;
		}
		pendingLinks = leaked.map((hit) => {
			const cite = citeWslpath(hit.nativePath);
			const label =
				hit.label !== undefined ? escapeMarkdownLabel(hit.label) : cite.label;
			// Only render links for paths that actually exist — a converted
			// link to a missing file cannot be opened either (it already
			// failed the point of the conversion). Report the rest as
			// plain text with the reason, so the quote is still visible.
			if (existsSync(hit.nativePath)) return `- [${label}](${cite.uri})`;
			return `- ${label} — 文件不存在，未转成链接 (${cite.uri})`;
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!pendingLinks) return;
		const links = pendingLinks;
		pendingLinks = undefined;

		// pi-lens-ignore: no-console-except-error, console-statement
		console.warn(
			`[pi-cite-wslpath] Delivered text has ${links.length} link(s) ` +
				`Windows Terminal cannot open; converted links posted to chat.`,
		);
		ctx.ui.notify(
			`[pi-cite-wslpath] ${links.length} 个不可打开的 file:// 链接已转为可点击链接（见下方系统消息）`,
			"warning",
		);
		pi.sendMessage({
			customType: "pi-cite-wslpath",
			content: [`>[!note] pi-cite-wslpath auto trans:`, ...links].join("\n"),
			display: true,
		});
	});
}
