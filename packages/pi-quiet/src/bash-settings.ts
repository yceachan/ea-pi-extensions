/**
 * Bash settings mirrored from Pi settings.json for the registerTool fallback path.
 *
 * When Quiet re-registers bash (no registerToolRenderer seam), it must pass the same
 * shellPath / shellCommandPrefix Pi's host would, or Windows installs with Git Bash
 * outside Program Files fail with "No bash shell found".
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";

/** Cap untrusted settings size (DoS / parse cost). */
export const MAX_SETTINGS_BYTES = 100_000;

export type BashToolSettings = {
	shellPath?: string;
	commandPrefix?: string;
};

function expandTilde(path: string, home: () => string = homedir): string {
	if (path === "~") return home();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(home(), path.slice(2));
	}
	return path;
}

/**
 * Pull bash-relevant fields from a settings.json object.
 * Unknown / invalid shapes yield {}.
 */
export function parseBashToolSettings(raw: unknown, home: () => string = homedir): BashToolSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const src = raw as Record<string, unknown>;
	const out: BashToolSettings = {};

	if (typeof src.shellPath === "string") {
		const trimmed = src.shellPath.trim();
		if (trimmed) out.shellPath = expandTilde(trimmed, home);
	}
	if (typeof src.shellCommandPrefix === "string") {
		out.commandPrefix = src.shellCommandPrefix;
	}
	return out;
}

/** Project fields override global for the two bash keys. */
export function mergeBashToolSettings(
	globalSettings: BashToolSettings,
	projectSettings: BashToolSettings,
): BashToolSettings {
	const shellPath = projectSettings.shellPath ?? globalSettings.shellPath;
	const commandPrefix = projectSettings.commandPrefix ?? globalSettings.commandPrefix;
	const out: BashToolSettings = {};
	if (shellPath !== undefined) out.shellPath = shellPath;
	if (commandPrefix !== undefined) out.commandPrefix = commandPrefix;
	return out;
}

function readSettingsObject(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		const st = lstatSync(path);
		if (!st.isFile() || st.size > MAX_SETTINGS_BYTES) return undefined;
		const text = readFileSync(path, "utf8");
		if (text.length > MAX_SETTINGS_BYTES) return undefined;
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Load bash options the way Pi does: global ~/.pi/agent/settings.json merged with
 * project .pi/settings.json (project wins per field).
 */
export function loadBashToolSettings(
	cwd: string,
	agentDir: string = getAgentDir(),
	home: () => string = homedir,
): BashToolSettings {
	const globalRaw = readSettingsObject(join(agentDir, "settings.json"));
	const projectRaw = readSettingsObject(join(cwd, ".pi", "settings.json"));
	return mergeBashToolSettings(
		parseBashToolSettings(globalRaw, home),
		parseBashToolSettings(projectRaw, home),
	);
}

/**
 * Factory for Quiet's bash registerTool override.
 * Inject createBash so unit tests can assert options without the peer package.
 */
export function createQuietBashToolDefinitionFactory<
	TDef,
	TOptions extends BashToolSettings = BashToolSettings,
>(
	createBash: (cwd: string, options?: TOptions) => TDef,
	loadSettings: (cwd: string) => BashToolSettings = loadBashToolSettings,
): (cwd: string) => TDef {
	return (cwd: string) => createBash(cwd, loadSettings(cwd) as TOptions);
}
