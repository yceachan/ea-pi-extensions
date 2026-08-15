/**
 * pi-registry access: models-store.json / auth.json reading + fuzzy matching.
 *
 * models-store.json shape (pi): { [providerId]: { api, baseUrl, models: [...] } }
 * auth.json shape (pi):        { [providerId]: { key } }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");
export const AUTH_PATH = join(AGENT_DIR, "auth.json");

export interface ModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelEntry {
	id?: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	input?: string[];
	cost?: ModelCost;
	[key: string]: unknown;
}

export interface ProviderStore {
	api?: string | null;
	baseUrl?: string | null;
	models?: ModelEntry[];
	[key: string]: unknown;
}

export type ModelsStore = Record<string, ProviderStore>;
export type AuthStore = Record<
	string,
	{ key?: string } & Record<string, unknown>
>;

export function readJsonFile(path: string): unknown | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

export function loadModelsStore(): ModelsStore {
	const raw = readJsonFile(MODELS_STORE_PATH);
	return raw && typeof raw === "object" ? (raw as ModelsStore) : {};
}

export function loadAuth(): AuthStore {
	const raw = readJsonFile(AUTH_PATH);
	return raw && typeof raw === "object" ? (raw as AuthStore) : {};
}

/** input absent = don't judge; input present without "image" = not vision-capable. */
export function isVisionCapable(m: ModelEntry): boolean {
	const inp = m.input;
	if (inp === undefined || inp === null) return true;
	if (Array.isArray(inp)) return inp.includes("image");
	return String(inp).includes("image");
}

/**
 * Fuzzy pick: exact (case-insensitive) > candidate contains needle >
 * needle contains candidate. No match = undefined (callers must decide
 * whether to error or fall back — silently picking candidates[0] would
 * route unknown providers to the wrong backend and bill it).
 */
export function fuzzyPick(
	needle: string,
	candidates: readonly string[],
): string | undefined {
	if (candidates.length === 0) return undefined;
	const n = needle.toLowerCase();
	const exact = candidates.find((c) => c.toLowerCase() === n);
	if (exact !== undefined) return exact;
	const contains = candidates.find((c) => c.toLowerCase().includes(n));
	if (contains !== undefined) return contains;
	const contained = candidates.find((c) => n.includes(c.toLowerCase()));
	if (contained !== undefined) return contained;
	return undefined;
}

/** Case-insensitive key lookup (the config schema mixes Provider/Model casing). */
export function pickCI(obj: Record<string, unknown>, key: string): unknown {
	if (obj[key] !== undefined) return obj[key];
	const lower = key.toLowerCase();
	for (const [k, v] of Object.entries(obj)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

export function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
