/**
 * Sticky Preference IO for Quiet Display.
 *
 * Config path (package-local, same family as spinner / preferred-thinking):
 *   $PI_CODING_AGENT_DIR/extensions/quiet.json
 *   (default: ~/.pi/agent/extensions/quiet.json)
 *
 * Shape: { "enabled": boolean }
 * Missing / invalid / oversized / non-regular → Quiet Display on (default).
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const CONFIG_FILENAME = "quiet.json";

/** Cap untrusted config file size (DoS / parse cost). */
export const MAX_CONFIG_BYTES = 100_000;

export interface QuietConfig {
	/** When true, Quiet Display is active for new tool rows. */
	enabled: boolean;
}

export function defaultQuietConfig(): QuietConfig {
	return { enabled: true };
}

/**
 * Same base dir as pi's agent config (including PI_CODING_AGENT_DIR).
 */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
	const envDir = env.PI_CODING_AGENT_DIR;
	return envDir
		? envDir.replace(/^~(\/|$)/, `${home()}$1`)
		: join(home(), ".pi", "agent");
}

export function getConfigPath(env: NodeJS.ProcessEnv = process.env, home: () => string = homedir): string {
	return join(getAgentDir(env, home), "extensions", CONFIG_FILENAME);
}

/**
 * Coerce unknown JSON into QuietConfig. Invalid input → default (enabled).
 */
export function parseQuietConfig(raw: unknown): QuietConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return defaultQuietConfig();
	}
	const src = raw as Record<string, unknown>;
	if (typeof src.enabled !== "boolean") {
		return defaultQuietConfig();
	}
	return { enabled: src.enabled };
}

/**
 * Load Sticky Preference from disk. Missing/invalid/oversized/non-regular → default on.
 */
export function loadQuietConfig(path: string = getConfigPath()): QuietConfig {
	try {
		if (!existsSync(path)) return defaultQuietConfig();
		const st = lstatSync(path);
		if (!st.isFile()) {
			console.warn(`[pi-quiet] ${path} is not a regular file; ignoring.`);
			return defaultQuietConfig();
		}
		if (st.size > MAX_CONFIG_BYTES) {
			console.warn(`[pi-quiet] ${path} is unexpectedly large (${st.size} bytes); ignoring.`);
			return defaultQuietConfig();
		}
		const text = readFileSync(path, "utf8");
		if (text.length > MAX_CONFIG_BYTES) {
			console.warn(`[pi-quiet] ${path} exceeds size cap; ignoring.`);
			return defaultQuietConfig();
		}
		return parseQuietConfig(JSON.parse(text));
	} catch (err) {
		console.warn(`[pi-quiet] Could not read ${path}: ${err instanceof Error ? err.message : err}`);
		return defaultQuietConfig();
	}
}

/**
 * Persist Sticky Preference. Atomic temp + rename, mode 0o600. Returns false on failure.
 */
export function saveQuietConfig(config: QuietConfig, path: string = getConfigPath()): boolean {
	const clean = parseQuietConfig(config);
	// Only persist explicit off; default-on can also be written for clarity when user runs /quiet on.
	const body = `${JSON.stringify({ enabled: clean.enabled }, null, "\t")}\n`;
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (existsSync(path)) {
			const st = lstatSync(path);
			if (!st.isFile()) {
				console.warn(`[pi-quiet] refusing to overwrite non-regular path ${path}`);
				return false;
			}
		}
		writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch (err) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			// best-effort temp cleanup
		}
		console.warn(`[pi-quiet] Could not write ${path}: ${err instanceof Error ? err.message : err}`);
		return false;
	}
}
