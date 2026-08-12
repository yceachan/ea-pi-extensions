/**
 * Pure helpers for the /cwd extension.
 *
 * No pi imports in this file — it is unit-testable with plain node
 * (type stripping, node >= 23.6: `node cwd-utils.test.ts`).
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Shorten a path for display: /home/pi/x -> ~/x */
export function shortenPath(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	return p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

/**
 * Resolve a user-supplied path:
 *  - "~" / "~/..." expand against $HOME
 *  - everything else resolves against `base` (the current cwd)
 */
export function resolveTargetPath(raw: string, base: string): string {
	if (raw === "~") return homedir();
	if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
	return resolve(base, raw);
}

/**
 * The session directory pi uses for a cwd:
 *   <agentDir>/sessions/--<encoded absolute cwd>--
 * Mirrors the encoding in pi's core/session-manager.js (getDefaultSessionDir).
 */
export function defaultSessionDirFor(cwd: string, agentDir: string): string {
	const abs = resolve(cwd);
	const safe = `--${abs.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir, "sessions", safe);
}

/**
 * Build the relocated session file for `targetCwd`'s session directory:
 * header `cwd` rewritten, every entry preserved, written under `fileName`
 * (same filename when the session file exists on disk) with the same
 * JSONL layout pi uses. Returns the new file path.
 *
 * Serializes from memory (header + entries) rather than copying the file:
 * pi does not always flush the session JSONL to disk (a session with only
 * extension-command interactions has no file yet), while the in-memory
 * SessionManager state is always authoritative and complete.
 *
 * Does NOT delete the source file — the caller deletes it only after the
 * session switch succeeded.
 */
export function buildMovedSessionFile(
	header: Record<string, unknown>,
	entries: unknown[],
	targetCwd: string,
	agentDir: string,
	fileName: string,
): string {
	if (typeof header.cwd !== "string") {
		throw new Error("invalid session header (missing cwd)");
	}
	const destDir = defaultSessionDirFor(targetCwd, agentDir);
	mkdirSync(destDir, { recursive: true });
	const destFile = join(destDir, fileName);
	const movedHeader = { ...header, cwd: resolve(targetCwd) };
	const lines = [
		JSON.stringify(movedHeader),
		...entries.map((e) => JSON.stringify(e)),
	];
	writeFileSync(destFile, `${lines.join("\n")}\n`, "utf8");
	return destFile;
}

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

/**
 * Directory completion for the /cwd argument.
 *
 * Rules:
 *  - directories only, prefix-matched on the last path segment
 *  - relative paths resolve against `base` (current cwd)
 *  - "~" / "~/..." resolve against $HOME and stay in ~ form
 *  - completed values keep the user's input form (relative / ~ / absolute)
 *  - directories complete with a trailing slash
 *  - dot-directories are hidden unless the typed segment starts with "."
 */
export function completeDirectories(
	prefix: string,
	base: string,
): CompletionItem[] {
	const lastSlash = prefix.lastIndexOf("/");
	const displayDir = lastSlash === -1 ? "" : prefix.slice(0, lastSlash + 1);
	const lastSeg = lastSlash === -1 ? prefix : prefix.slice(lastSlash + 1);

	// Bare "~" lists $HOME contents, inserting "~/name" — same as "~/".
	const bareTilde = prefix === "~";
	const filterSeg = bareTilde ? "" : lastSeg;

	let parentAbs: string;
	let valuePrefix: string;
	if (bareTilde || displayDir.startsWith("~/")) {
		parentAbs = join(homedir(), displayDir.slice(1));
		valuePrefix = displayDir === "" ? "~/" : displayDir;
	} else if (displayDir.startsWith("/")) {
		parentAbs = displayDir;
		valuePrefix = displayDir;
	} else {
		parentAbs = resolve(base, displayDir);
		valuePrefix = displayDir;
	}

	let names: string[];
	try {
		names = readdirSync(parentAbs, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();
	} catch {
		return []; // parent does not exist or is unreadable — nothing to complete
	}

	const showHidden = filterSeg.startsWith(".");
	const items: CompletionItem[] = [];
	for (const name of names) {
		if (name.startsWith(".") && !showHidden) continue;
		if (!name.startsWith(filterSeg)) continue;
		const value = `${valuePrefix}${name}/`;
		items.push({ value, label: value, description: join(parentAbs, name) });
	}
	return items;
}
