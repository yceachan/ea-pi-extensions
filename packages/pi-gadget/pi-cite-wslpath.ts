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
 * in the system prompt.
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
 * In Windows Terminal the user opens hyperlinks with Ctrl+click.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
			"Call this whenever you cite or print a file path in your reply.",
		promptSnippet:
			"pi_cite_wslpath: native path -> Windows-openable OSC 8 / markdown / URI hyperlink text (Ctrl+click opens it in Windows Terminal).",
		promptGuidelines: [
			"When citing file paths in replies, call pi_cite_wslpath first and use its markdown form in chat text, or its osc8 form when writing a raw text stream.",
			"Never emit raw file:///home/..., file:///tmp/... or file:///mnt/... links — Windows Terminal rejects them.",
		],
		parameters: Type.Object({
			path: Type.String(),
			label: Type.Optional(Type.String()),
			form: Type.Optional(
				Type.Union([
					Type.Literal("osc8"),
					Type.Literal("markdown"),
					Type.Literal("both"),
				]),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const {
				uri,
				osc8: osc8Text,
				markdown,
			} = citeWslpath(params.path, { label: params.label });
			const form = params.form ?? "both";
			const parts: string[] = [];
			if (form === "osc8" || form === "both") parts.push(`osc8:\n${osc8Text}`);
			if (form === "markdown" || form === "both")
				parts.push(`markdown:\n${markdown}`);
			parts.push(`uri:\n${uri}`);
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: {},
			};
		},
	});
}
