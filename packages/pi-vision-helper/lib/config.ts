/**
 * Config resolution for pi-vision-helper.
 *
 * Config files, first found wins:
 *   1. --config <path> / explicit path        (missing file = hard error)
 *   2. $PI_VISION_HELPER_CONFIG               (missing file = hard error)
 *   3. $CWD/.pi/vision-helper.json            (project-level)
 *   4. ~/.pi/agent/pi-vision-helper.json      (user-level)
 *
 * New schema (vision.models[]); legacy flat fields (provider/model/baseUrl/
 * apiKey/apiKeyEnv/cost/headers/defaults/modelMatch) are still understood and
 * normalized into a single synthetic model when `vision` is absent.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord, asString, pickCI, type ModelCost } from "./registry.ts";
import { EFFORTS, MAX_MAX_TOKENS, MIN_MAX_TOKENS } from "./vision.ts";

export const CONFIG_ENV = "PI_VISION_HELPER_CONFIG";
export const USER_CONFIG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"pi-vision-helper.json",
);

export interface VisionModelConfig {
	name: string;
	type: "pi-registry" | "responses";
	/** pi-registry: fuzzy provider id; responses: unused */
	provider?: string;
	/** pi-registry: fuzzy model id; responses: literal model id */
	model?: string;
	baseUrl?: string;
	/** literal key or $ENV_VAR reference */
	apiKey?: string;
	headers?: Record<string, string>;
	cost?: ModelCost;
}

export interface LegacyConfig {
	provider?: string;
	model?: string;
	modelMatch?: "exact" | "substring";
	baseUrl?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	cost?: ModelCost;
	headers?: Record<string, string>;
	defaults?: { effort?: string; maxTokens?: number };
}

export interface ResolvedConfig {
	path: string | undefined;
	raw: Record<string, unknown>;
	enabled: boolean;
	forceVisionBridge: boolean;
	defaultEffort?: string;
	maxTokens?: number;
	timeoutMs?: number;
	systemPrompt?: string;
	vision: { active?: string; models: VisionModelConfig[] };
	legacy?: LegacyConfig;
}

export interface ConfigPathArgs {
	explicit?: string;
	cwd?: string;
}

export function findConfigPath(args: ConfigPathArgs = {}): string | undefined {
	const candidates: string[] = [];
	if (args.explicit) {
		if (!existsSync(args.explicit)) {
			throw new Error(`--config '${args.explicit}' does not exist`);
		}
		candidates.push(args.explicit);
	}
	const env = process.env[CONFIG_ENV];
	if (env) {
		if (!existsSync(env)) {
			throw new Error(`${CONFIG_ENV} points to a missing file: '${env}'`);
		}
		candidates.push(env);
	}
	const cwd = args.cwd ?? process.cwd();
	candidates.push(join(cwd, ".pi", "vision-helper.json"));
	candidates.push(USER_CONFIG_PATH);
	return candidates.find((c) => existsSync(c));
}

function parseCost(v: unknown, where: string): ModelCost | undefined {
	const rec = asRecord(v);
	if (!rec) return undefined;
	const cost: ModelCost = {};
	for (const [k, val] of Object.entries(rec)) {
		if (!["input", "output", "cacheRead", "cacheWrite"].includes(k)) continue;
		const n = typeof val === "number" ? val : Number(val);
		if (!Number.isFinite(n)) {
			throw new Error(`cost.${k} must be a number in ${where}`);
		}
		(cost as Record<string, number>)[k] = n;
	}
	return cost;
}

function parseModelEntry(raw: unknown, index: number): VisionModelConfig {
	const rec = asRecord(raw);
	if (!rec) throw new Error(`vision.models[${index}] must be an object`);

	const type = asString(pickCI(rec, "type")) ?? "pi-registry";
	if (type !== "pi-registry" && type !== "responses") {
		throw new Error(
			`vision.models[${index}].type must be 'pi-registry' or 'responses', got '${type}'`,
		);
	}

	const provider = asString(pickCI(rec, "Provider"));
	const model = asString(pickCI(rec, "Model")) ?? asString(pickCI(rec, "model"));
	const name =
		asString(pickCI(rec, "name")) ??
		(type === "responses" ? model : `${provider ?? ""}/${model ?? ""}`) ??
		`model-${index}`;

	return {
		name,
		type: type as "pi-registry" | "responses",
		provider,
		model,
		baseUrl: asString(pickCI(rec, "baseUrl")),
		apiKey: asString(pickCI(rec, "apiKey")),
		headers: (asRecord(pickCI(rec, "headers")) ?? undefined) as
			| Record<string, string>
			| undefined,
		cost: parseCost(pickCI(rec, "cost"), `vision.models[${index}]`),
	};
}

function assertEffort(value: string | undefined, where: string): void {
	if (value !== undefined && !EFFORTS.includes(value as (typeof EFFORTS)[number])) {
		throw new Error(
			`${where} must be one of ${EFFORTS.join("/")}, got '${value}'`,
		);
	}
}

function assertMaxTokens(value: number | undefined, where: string): void {
	if (
		value !== undefined &&
		(value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS)
	) {
		throw new Error(
			`${where} must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}, got ${value}`,
		);
	}
}

function parseLegacy(raw: Record<string, unknown>): LegacyConfig | undefined {
	const has =
		raw.provider !== undefined ||
		raw.model !== undefined ||
		raw.baseUrl !== undefined ||
		raw.apiKey !== undefined ||
		raw.apiKeyEnv !== undefined ||
		raw.cost !== undefined ||
		raw.headers !== undefined ||
		raw.defaults !== undefined;
	if (!has) return undefined;

	const match = asString(raw.modelMatch) ?? "exact";
	if (match !== "exact" && match !== "substring") {
		throw new Error(`modelMatch must be 'exact' or 'substring', got '${match}'`);
	}
	const defaults = asRecord(raw.defaults);
	const defaultsEffort = asString(defaults?.effort);
	const defaultsMaxTokens = parseNumber(defaults?.maxTokens, "defaults.maxTokens");
	assertEffort(defaultsEffort, "defaults.effort");
	assertMaxTokens(defaultsMaxTokens, "defaults.maxTokens");
	return {
		provider: asString(raw.provider),
		model: asString(raw.model),
		modelMatch: match as "exact" | "substring",
		baseUrl: asString(raw.baseUrl),
		apiKey: asString(raw.apiKey),
		apiKeyEnv: asString(raw.apiKeyEnv),
		cost: parseCost(raw.cost, "config"),
		headers: (asRecord(raw.headers) ?? undefined) as
			| Record<string, string>
			| undefined,
		defaults:
			defaultsEffort !== undefined || defaultsMaxTokens !== undefined
				? { effort: defaultsEffort, maxTokens: defaultsMaxTokens }
				: undefined,
	};
}

function parseNumber(raw: unknown, key: string): number | undefined {
	if (raw === undefined || raw === null) return undefined;
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
	return n;
}

/** Load and normalize a config file. Never throws for a missing optional file. */
export function loadConfig(args: ConfigPathArgs = {}): ResolvedConfig {
	const path = findConfigPath(args);
	let raw: Record<string, unknown> = {};
	if (path) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		} catch (e) {
			throw new Error(
				`cannot read ${path}: ${e instanceof Error ? e.message : e}`,
			);
		}
		const rec = asRecord(parsed);
		if (!rec) throw new Error(`config ${path} must be a JSON object`);
		raw = rec;
	}

	const enabled = raw.enabled !== false;
	const forceVisionBridge = raw.forceVisionBridge === true;

	const visionRaw = asRecord(raw.vision);
	const modelsRaw = Array.isArray(visionRaw?.models) ? visionRaw.models : [];
	const models = modelsRaw.map((m, i) => parseModelEntry(m, i));

	const defaultEffort = asString(raw.defaultEffort);
	assertEffort(defaultEffort, "defaultEffort");
	const maxTokens = parseNumber(raw.maxTokens, "maxTokens");
	assertMaxTokens(maxTokens, "maxTokens");

	return {
		path,
		raw,
		enabled,
		forceVisionBridge,
		defaultEffort,
		maxTokens,
		timeoutMs: parseNumber(raw.timeoutMs, "timeoutMs"),
		systemPrompt: asString(raw.systemPrompt),
		vision: {
			active: asString(visionRaw?.active),
			models,
		},
		legacy: visionRaw || models.length > 0 ? undefined : parseLegacy(raw),
	};
}
