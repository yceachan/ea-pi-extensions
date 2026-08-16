/**
 * pi-cite-wslpath — single-file gadget: turn a native (WSL) path into a
 * Windows-Terminal-openable hyperlink text stream.
 *
 * Why: pi runs inside WSL, so tool/agent output that cites files with
 * `file:///home/...`, `file:///tmp/...`, or `file:///mnt/c/...` URIs cannot be
 * opened from Windows Terminal — its `file://` whitelist only accepts
 * Windows-accessible forms:
 *
 *   - `file:///C:/...`                (drvfs: /mnt/<drive> IS the Windows drive)
 *   - `file://wsl.localhost/<distro>/...`  (9P bridge, WT >= 1.17)
 *
 * The `pi_cite_wslpath` tool lets the model convert any native path to
 * clickable hyperlink text directly, without hard-coding the conversion rules
 * in the system prompt. Paths arrive as a `paths` array, so one tool call
 * converts any number of paths — citing several files costs a single request
 * instead of N.
 *
 * Returns three interchangeable forms:
 *   - osc8:      raw OSC 8 sequence — paste verbatim into raw output streams;
 *                the terminal registers the hyperlink at write time, so it is
 *                clickable even while the model is still streaming.
 *   - markdown:  [label](uri) — for normal chat replies; pi's markdown
 *                renderer converts it to an OSC 8 hyperlink itself.
 *   - uri:       plain URI text — fallback (relies on the terminal's URL
 *                auto-detection, which only kicks in once output settles).
 *
 * agent_end force-check: after every agent run, the delivered assistant text
 * is scanned for `file://` URIs Windows Terminal would reject (empty-host
 * `file:///` or `file://localhost` with a non-drive first segment — i.e.
 * /home, /tmp, /mnt, ...). A missed cite call can no longer slip through
 * silently: the user gets a warning notification with the converted links.
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

/** Wrap text in an OSC 8 hyperlink sequence (write-time hyperlink registration). */
export function osc8(text: string, uri: string): string {
	return `\x1b]8;;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export interface CiteResult {
	/** Windows-openable file URI. */
	uri: string;
	/** Raw OSC 8 hyperlink sequence. */
	osc8: string;
	/** Markdown link form (pi chat renders this as an OSC 8 hyperlink). */
	markdown: string;
	/** Display label used for the hyperlink. */
	label: string;
}

/** Full conversion: native path -> { uri, osc8, markdown, label }. */
export function citeWslpath(
	nativePath: string,
	options: CiteOptions = {},
): CiteResult {
	const uri = toWindowsFileUri(nativePath, options);
	const label = options.label ?? shortenLabel(nativePath);
	return {
		uri,
		osc8: osc8(label, uri),
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

/** How many converted links to include in the agent_end warning. */
const MAX_WARN_LINKS = 3;

/** Minimal structural view of a message, enough to scan assistant text. */
interface MessageLike {
	role?: string;
	content?: string | readonly { type?: string; text?: string }[];
}

/**
 * Find `file://` URIs in text that Windows Terminal would refuse to open.
 * Deduplicated, first-seen order. Example quotes are skipped: URIs inside
 * backtick code spans or fenced code blocks (they render as plain text, not
 * links), and ones ending in an ellipsis (`...`/`…`) — guideline texts quote
 * exactly these forms.
 */
export function findWindowsBrokenFileUris(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	let lineStart = 0;
	let inFence = false;
	for (const match of text.matchAll(WINDOWS_BROKEN_FILE_URI_RE)) {
		// Advance the line state up to the match's line (fence toggling).
		while (true) {
			const lineEnd = text.indexOf("\n", lineStart);
			const end = lineEnd === -1 ? text.length : lineEnd;
			if (match.index <= end) break;
			if (isFenceLine(text.slice(lineStart, end))) inFence = !inFence;
			lineStart = end + 1;
		}
		if (inFence) continue;
		const before = text.slice(lineStart, match.index);
		let backticks = 0;
		for (const ch of before) {
			if (ch === "`") backticks++;
		}
		if (backticks % 2 === 1) continue; // inside an inline code span
		if (match[0].endsWith("...") || match[0].endsWith("…")) continue;
		if (seen.has(match[0])) continue;
		seen.add(match[0]);
		found.push(match[0]);
	}
	return found;
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
 * Scan the assistant message texts of an agent run for leaked Linux
 * `file://` URIs (deduplicated). This is the agent_end force-check.
 */
export function findDeliveredBrokenFileUris(
	messages: readonly MessageLike[],
): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string" || !message.content) continue;
		for (const block of message.content) {
			if (block.type !== "text" || !block.text) continue;
			for (const uri of findWindowsBrokenFileUris(block.text)) {
				if (seen.has(uri)) continue;
				seen.add(uri);
				found.push(uri);
			}
		}
	}
	return found;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi_cite_wslpath",
		label: "Cite WSL Path",
		description:
			"Convert a native (WSL) file path into Windows-Terminal-openable hyperlink text. " +
			"pi runs in WSL, so plain file:///home/... or file:///mnt/c/... links cannot be opened " +
			"from the terminal; this tool rewrites them to Windows-accessible URIs " +
			"(/mnt/<drive> -> file:///<DRIVE>:/..., other paths -> file://wsl.localhost/<distro>/...). " +
			"Returns three interchangeable forms: 'osc8' (raw OSC 8 hyperlink sequence — paste it " +
			"verbatim into raw output streams; registered at write time, so it is clickable even " +
			"while pi is still streaming), 'markdown' ([label](uri) — preferred for normal chat " +
			"replies, pi renders it as a clickable hyperlink), and 'uri' (plain URI fallback). " +
			"The user opens the link in Windows Terminal with Ctrl+click. " +
			"Call this whenever you cite or print file paths in your reply — " +
			"batch them into a single `paths` array instead of one call per path.",
		promptSnippet:
			"pi_cite_wslpath: native paths (batch `paths` array) -> Windows-openable OSC 8 / markdown / URI hyperlink text (Ctrl+click opens it in Windows Terminal).",
		promptGuidelines: [
			"When citing file paths in replies, call pi_cite_wslpath first and use its markdown form in chat text, or its osc8 form when writing a raw text stream.",
			"Never emit raw file:///home/..., file:///tmp/... or file:///mnt/... links — Windows Terminal rejects them.",
			"Batch multiple file paths into one pi_cite_wslpath call (paths array) instead of one call per path.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
			form: Type.Optional(
				Type.Union([
					Type.Literal("osc8"),
					Type.Literal("markdown"),
					Type.Literal("both"),
				]),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const form = params.form ?? "both";
			const sections = params.paths.map((path, index) => {
				const { uri, osc8: osc8Text, markdown, label } = citeWslpath(path);
				const parts = [`${index + 1}. path: ${path}`, `   label: ${label}`];
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
				parts.push(`   uri:\n${uri}`);
				if (form === "osc8" || form === "both") parts.push(`   osc8:\n${osc8Text}`);
				if (form === "markdown" || form === "both")
					parts.push(`   markdown:\n${markdown}`);
				return parts.join("\n");
			});
			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {},
			};
		},
	});

	// Force-check the delivered reply for links Windows Terminal cannot open.
	// A missed pi_cite_wslpath call in the final delivery surfaces here as a
	// warning notification with the converted links, instead of silently
	// producing dead links in the transcript.
	pi.on("agent_end", (event, ctx) => {
		if (!isWslEnvironment()) return;
		const leaked = findDeliveredBrokenFileUris(event.messages);
		if (leaked.length === 0) return;

		const lines = leaked.slice(0, MAX_WARN_LINKS).map((uri) => {
			const path = leakedFileUriToPath(uri);
			return `- ${path ? citeWslpath(path).markdown : uri}`;
		});
		const more =
			leaked.length > MAX_WARN_LINKS
				? `\n- ... and ${leaked.length - MAX_WARN_LINKS} more`
				: "";
		const message =
			`[pi-cite-wslpath] Delivered text has ${leaked.length} file:// link(s) ` +
			`Windows Terminal cannot open (Linux-side path). Converted:\n` +
			`${lines.join("\n")}${more}` +
			`\nAsk the agent to re-cite them via pi_cite_wslpath.`;
		console.warn(message);
		ctx.ui.notify(message, "warning");
	});
}
