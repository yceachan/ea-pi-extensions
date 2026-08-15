/**
 * Core vision logic: target resolution (pi-registry / responses / legacy /
 * default) and the OpenAI Responses API round trip. Pure Node — no python.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	fuzzyPick,
	isVisionCapable,
	loadAuth,
	loadModelsStore,
	type ModelCost,
	type ModelEntry,
} from "./registry";
import type { LegacyConfig, ResolvedConfig, VisionModelConfig } from "./config";

export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const EFFORTS = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
const DEFAULT_MODEL_SUBSTRING = "luna";
const BUILTIN_SYSTEM_PROMPT =
	"You are a vision assistant. Answer the user's question about the provided " +
	"image(s) accurately and in detail. If the image contains text, transcribe " +
	"it verbatim.";

export interface VisionTarget {
	name: string;
	type: "pi-registry" | "responses" | "legacy" | "default";
	modelId: string;
	provider?: string;
	baseUrl: string;
	apiKey: string;
	keyFrom: string;
	cost: { input: number; output: number };
	headers: Record<string, string>;
}

export interface VisionOptions {
	images: string[];
	prompt: string;
	effort?: string;
	maxTokens: number;
	timeoutMs: number;
	systemPrompt: string;
}

export interface VisionOutcome {
	text: string;
	model: string;
	status: string;
	usage: { input: number; output: number; reasoning: number };
	cost: { input: number; output: number };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve a Windows-style or WSL-style path to a real file. */
export function resolveImagePath(p: string): string {
	const cleaned = p.trim().replaceAll("\\", "/");
	if (existsSync(cleaned)) return cleaned;
	const m = /^([A-Za-z]):\/(.*)$/.exec(cleaned);
	if (m) {
		const cand = `/mnt/${m[1].toLowerCase()}/${m[2]}`;
		if (existsSync(cand)) return cand;
		throw new Error(`image not found: ${p!} (also tried ${cand!})`);
	}
	throw new Error(`image not found: ${p!}`);
}

const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

function mimeOf(fp: string): string {
	const dot = fp.lastIndexOf(".");
	const ext = dot >= 0 ? fp.slice(dot).toLowerCase() : "";
	return EXT_MIME[ext] ?? "image/jpeg";
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function zeroCost(): { input: number; output: number } {
	return { input: 0, output: 0 };
}

function normalizeCost(cost?: ModelCost): { input: number; output: number } {
	return {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
	};
}

function modelKeyError(provider: string | undefined, keyFrom: string): Error {
	return new Error(
		`no API key — set apiKey ($ENV_VAR or literal) on the model entry, ` +
			`or add ${provider ?? "the provider"} to ${"~/.pi/agent/auth.json"} (tried ${keyFrom})`,
	);
}

function resolveRegistryEntry(
	cfgModel: VisionModelConfig,
	store: ReturnType<typeof loadModelsStore>,
	auth: ReturnType<typeof loadAuth>,
): VisionTarget {
	const providerIds = Object.keys(store);
	const provider = cfgModel.provider
		? fuzzyPick(cfgModel.provider, providerIds)
		: providerIds[0];
	if (!provider) {
		if (providerIds.length === 0) {
			throw new Error(
				`pi-registry model '${cfgModel.name}': no providers in models-store.json`,
			);
		}
		throw new Error(
			`pi-registry model '${cfgModel.name}': provider '${cfgModel.provider}' not found — ` +
				`available providers: ${providerIds.join(", ")}`,
		);
	}
	const providerStore = store[provider];
	const entries = providerStore?.models ?? [];

	let modelEntry: ModelEntry | undefined;
	let modelId: string;
	if (cfgModel.model) {
		// prefer vision-capable candidates, fall back to all entries
		const visionIds = entries.filter(isVisionCapable).map((m) => m.id ?? "");
		const allIds = entries.map((m) => m.id ?? "");
		modelId =
			fuzzyPick(cfgModel.model, visionIds.length > 0 ? visionIds : allIds) ?? "";
		modelEntry = entries.find((m) => m.id === modelId);
	} else {
		modelEntry =
			entries.find(
				(m) =>
					(m.id ?? "").toLowerCase().includes(DEFAULT_MODEL_SUBSTRING) &&
					isVisionCapable(m),
			) ?? entries.find(isVisionCapable);
		modelId = modelEntry?.id ?? "";
	}
	if (!modelId || !modelEntry) {
		const available = entries
			.filter(isVisionCapable)
			.map((m) => m.id ?? "")
			.join(", ");
		throw new Error(
			`pi-registry model '${cfgModel.name}': no model matched in provider '${provider}'` +
				(cfgModel.model ? ` (fuzzy '${cfgModel.model}')` : "") +
				` — vision-capable models: ${available || "(none)"}`,
		);
	}

	const keyFrom = `auth.json[${provider}]`;
	const apiKey = (auth[provider] as { key?: string } | undefined)?.key;
	if (!apiKey) throw modelKeyError(provider, keyFrom);

	return {
		name: cfgModel.name,
		type: "pi-registry",
		modelId,
		provider,
		baseUrl: (
			modelEntry.baseUrl ||
			providerStore.baseUrl ||
			DEFAULT_BASE_URL
		).replace(/\/+$/, ""),
		apiKey,
		keyFrom,
		cost: normalizeCost(modelEntry.cost),
		headers: {},
	};
}

function expandApiKeyRef(apiKey: string): string {
	const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(apiKey.trim());
	if (m) {
		const v = process.env[m[1]];
		if (v === undefined || v === "") {
			throw new Error(
				`apiKey references $${m[1]} which is not set in the environment`,
			);
		}
		return v;
	}
	return apiKey;
}

function resolveResponsesEntry(cfgModel: VisionModelConfig): VisionTarget {
	if (!cfgModel.model) {
		throw new Error(`responses model '${cfgModel.name}' requires 'model'`);
	}
	if (!cfgModel.baseUrl) {
		throw new Error(`responses model '${cfgModel.name}' requires 'baseUrl'`);
	}
	if (!cfgModel.apiKey) {
		throw new Error(
			`responses model '${cfgModel.name}' requires 'apiKey' ($ENV_VAR or literal)`,
		);
	}
	return {
		name: cfgModel.name,
		type: "responses",
		modelId: cfgModel.model,
		baseUrl: cfgModel.baseUrl.replace(/\/+$/, ""),
		apiKey: expandApiKeyRef(cfgModel.apiKey),
		keyFrom: cfgModel.apiKey.startsWith("$")
			? `env:${cfgModel.apiKey.slice(1)}`
			: "config apiKey",
		cost: normalizeCost(cfgModel.cost),
		headers: cfgModel.headers ?? {},
	};
}

/** Legacy flat config → one synthetic model (old behavior preserved). */
function resolveLegacy(
	legacy: LegacyConfig,
	store: ReturnType<typeof loadModelsStore>,
	auth: ReturnType<typeof loadAuth>,
): VisionTarget {
	const providerIds = Object.keys(store);
	const provider = legacy.provider ?? providerIds[0];
	if (!provider || !store[provider]) {
		throw new Error(
			`no provider matched in models-store.json (provider='${legacy.provider ?? ""}') — ` +
				`available providers: ${providerIds.join(", ") || "(none)"}`,
		);
	}
	const entries = store[provider].models ?? [];

	let modelEntry: ModelEntry | undefined;
	let modelId = legacy.model;
	if (modelId) {
		const visionIds = entries.filter(isVisionCapable).map((m) => m.id ?? "");
		const allIds = entries.map((m) => m.id ?? "");
		const candidates = legacy.modelMatch === "substring" ? allIds : visionIds;
		modelId = fuzzyPick(modelId, candidates.length > 0 ? candidates : allIds);
		modelEntry = entries.find((m) => m.id === modelId);
	} else {
		modelEntry =
			entries.find(
				(m) =>
					(m.id ?? "").toLowerCase().includes(DEFAULT_MODEL_SUBSTRING) &&
					isVisionCapable(m),
			) ?? entries.find(isVisionCapable);
		modelId = modelEntry?.id;
	}

	// custom API overrides
	let apiKey: string | undefined;
	let keyFrom: string;
	if (legacy.apiKey) {
		apiKey = expandApiKeyRef(legacy.apiKey);
		keyFrom = legacy.apiKey.startsWith("$")
			? `env:${legacy.apiKey.slice(1)}`
			: "config apiKey";
	} else if (legacy.apiKeyEnv) {
		apiKey = process.env[legacy.apiKeyEnv];
		if (!apiKey) {
			throw new Error(
				`apiKeyEnv '${legacy.apiKeyEnv}' is not set in the environment`,
			);
		}
		keyFrom = `env:${legacy.apiKeyEnv}`;
	} else {
		apiKey = (auth[provider] as { key?: string } | undefined)?.key;
		keyFrom = `auth.json[provider]`;
	}
	if (!modelId && !legacy.apiKey && !legacy.apiKeyEnv) {
		const vision = Object.entries(store)
			.flatMap(([p, s]) =>
				(s.models ?? []).filter(isVisionCapable).map((m) => `${p}/${m.id}`),
			)
			.join(", ");
		throw new Error(
			`no vision model matched in models-store.json (model='${legacy.model ?? ""}'). ` +
				`Vision-capable models: ${vision || "(none)"}. Set 'model' in the config, ` +
				`or supply a custom API (baseUrl + apiKey/apiKeyEnv).`,
		);
	}
	if (!modelId) {
		throw new Error("custom API mode requires 'model' in the config");
	}
	if (!apiKey) throw modelKeyError(provider, keyFrom);

	const baseUrl =
		legacy.baseUrl ??
		modelEntry?.baseUrl ??
		store[provider].baseUrl ??
		DEFAULT_BASE_URL;
	return {
		name: "legacy",
		type: "legacy",
		modelId,
		provider,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		keyFrom,
		cost: normalizeCost(legacy.cost ?? modelEntry?.cost),
		headers: legacy.headers ?? {},
	};
}

function resolveDefaultLuna(
	store: ReturnType<typeof loadModelsStore>,
	auth: ReturnType<typeof loadAuth>,
): VisionTarget {
	for (const [provider, providerStore] of Object.entries(store)) {
		for (const m of providerStore.models ?? []) {
			if (
				(m.id ?? "").toLowerCase().includes(DEFAULT_MODEL_SUBSTRING) &&
				isVisionCapable(m)
			) {
				const apiKey = (auth[provider] as { key?: string } | undefined)?.key;
				if (!apiKey) throw modelKeyError(provider, `auth.json[${provider}]`);
				return {
					name: `${provider}/${m.id}`,
					type: "default",
					modelId: m.id ?? "",
					provider,
					baseUrl: (m.baseUrl || providerStore.baseUrl || DEFAULT_BASE_URL).replace(
						/\/+$/,
						"",
					),
					apiKey,
					keyFrom: `auth.json[${provider}]`,
					cost: normalizeCost(m.cost),
					headers: {},
				};
			}
		}
	}
	throw new Error(
		"no vision-capable luna model found in models-store.json — add one, " +
			"or configure vision.models in the vision-helper config",
	);
}

/** Pick the active model: vision.active > first entry > legacy > default luna search. */
export function resolveTarget(cfg: ResolvedConfig): VisionTarget {
	const store = loadModelsStore();
	const auth = loadAuth();

	if (cfg.vision.models.length > 0) {
		const active =
			cfg.vision.models.find((m) => m.name === cfg.vision.active) ??
			cfg.vision.models[0];
		return active.type === "pi-registry"
			? resolveRegistryEntry(active, store, auth)
			: resolveResponsesEntry(active);
	}
	if (cfg.legacy) return resolveLegacy(cfg.legacy, store, auth);
	return resolveDefaultLuna(store, auth);
}

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

interface ApiResponse {
	model?: string;
	status?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		output_tokens_details?: { reasoning_tokens?: number };
	};
	output?: unknown[];
	error?: unknown;
	[key: string]: unknown;
}

function collectText(items: unknown[]): string[] {
	const texts: string[] = [];
	for (const it of items) {
		if (!it || typeof it !== "object") continue;
		const rec = it as Record<string, unknown>;
		if (rec.type === "output_text" && typeof rec.text === "string") {
			texts.push(rec.text);
		} else if (rec.type === "message" && Array.isArray(rec.content)) {
			texts.push(...collectText(rec.content as unknown[]));
		}
	}
	return texts;
}

export async function runVision(
	target: VisionTarget,
	options: VisionOptions,
): Promise<VisionOutcome> {
	const content: Array<Record<string, string>> = [
		{ type: "input_text", text: options.prompt },
	];
	for (const img of options.images) {
		const fp = resolveImagePath(img);
		let b64: string;
		try {
			b64 = readFileSync(fp).toString("base64");
		} catch (e) {
			throw new Error(`cannot read ${fp}: ${e instanceof Error ? e.message : e}`);
		}
		const mime = mimeOf(fp);
		content.push({
			type: "input_image",
			image_url: `data:${mime};base64,${b64}`,
		});
	}

	const effort = options.effort ?? "high";
	if (!EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
		throw new Error(
			`effort must be one of ${EFFORTS.join("/")}, got '${effort}'`,
		);
	}

	const payload: Record<string, unknown> = {
		model: target.modelId,
		instructions: options.systemPrompt || BUILTIN_SYSTEM_PROMPT,
		input: [{ role: "user", content }],
		max_output_tokens: options.maxTokens,
	};
	// The zen gateway maps off/minimal to null (omit reasoning); sending them
	// verbatim produces HTTP 400 invalid_prompt.
	if (effort !== "off" && effort !== "minimal") {
		payload.reasoning = { effort };
	}

	const url = `${target.baseUrl}/responses`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${target.apiKey}`,
				"Content-Type": "application/json",
				// Cloudflare on opencode.ai rejects non-browser UAs (HTTP 403, error 1010)
				"User-Agent": "curl/8.5.0",
				Accept: "*/*",
				...target.headers,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (e) {
		throw new Error(
			`request to ${url} failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 2000);
		throw new Error(`HTTP ${res.status} from ${url}:\n${body}`);
	}
	const data = (await res.json()) as ApiResponse;

	const usageIn = data.usage?.input_tokens ?? 0;
	const usageOut = data.usage?.output_tokens ?? 0;
	const reasoning = data.usage?.output_tokens_details?.reasoning_tokens ?? 0;

	const texts = collectText(data.output ?? []);
	if (texts.length === 0) {
		throw new Error(
			`no output_text in response (raw response below):\n` +
				JSON.stringify(data).slice(0, 2000),
		);
	}

	return {
		text: texts.join("\n"),
		model: data.model ?? target.modelId,
		status: data.status ?? "completed",
		usage: { input: usageIn, output: usageOut, reasoning },
		cost: {
			input: (usageIn / 1e6) * target.cost.input,
			output: (usageOut / 1e6) * target.cost.output,
		},
	};
}
