#!/usr/bin/env bun
/**
 * pi-vision-helper CLI — manual debugging entry, same lib/ as the pi tool.
 *
 *   bun scripts/vision.ts <img...> --prompt "..." [--config path] [--model name]
 *                          [--effort high] [--max-tokens 4096] [--timeout 60000]
 *                          [--json]
 *
 * --model <name> selects a vision.models[] entry by name (overrides
 * vision.active); without it, vision.active / first entry / legacy /
 * default-luna-search applies — identical to the tool's resolution.
 */

import { loadConfig } from "../../../lib/config.ts";
import {
	MAX_MAX_TOKENS,
	MIN_MAX_TOKENS,
	runVision,
	resolveTarget,
} from "../../../lib/vision.ts";

function fail(msg: string): never {
	process.stderr.write(`ERROR: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): {
	images: string[];
	prompt: string;
	config?: string;
	model?: string;
	effort?: string;
	maxTokens?: number;
	timeout?: number;
	json: boolean;
} {
	const images: string[] = [];
	let prompt: string | undefined;
	let config: string | undefined;
	let model: string | undefined;
	let effort: string | undefined;
	let maxTokens: number | undefined;
	let timeout: number | undefined;
	let json = false;

	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(
			"usage: bun vision.ts <img...> --prompt <text> [--config <path>] " +
				"[--model <name>] [--effort <e>] [--max-tokens <n>] [--timeout <ms>] [--json]\n",
		);
		process.exit(0);
	}

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = (): string => {
			if (i + 1 >= argv.length) fail(`missing value for ${a}`);
			return argv[++i];
		};
		switch (a) {
			case "--prompt":
				prompt = next();
				break;
			case "--config":
				config = next();
				break;
			case "--model":
				model = next();
				break;
			case "--effort":
				effort = next();
				break;
			case "--max-tokens":
				maxTokens = Number(next());
				if (!Number.isFinite(maxTokens)) fail("--max-tokens must be a number");
				if (maxTokens < MIN_MAX_TOKENS || maxTokens > MAX_MAX_TOKENS) {
					fail(
						`--max-tokens must be between ${MIN_MAX_TOKENS} and ${MAX_MAX_TOKENS}, got ${maxTokens}`,
					);
				}
				break;
			case "--timeout":
				timeout = Number(next());
				if (!Number.isFinite(timeout)) fail("--timeout must be a number");
				break;
			case "--json":
				json = true;
				break;
			default:
				if (a.startsWith("--")) fail(`unknown option ${a}`);
				images.push(a);
		}
	}
	if (images.length === 0) fail("at least one image path is required");
	if (!prompt) fail("--prompt is required");
	return { images, prompt, config, model, effort, maxTokens, timeout, json };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const cfg = loadConfig({ explicit: args.config });
	if (!cfg.enabled)
		fail("pi-vision-helper is disabled by config (enabled=false)");

	// --model: pick a vision.models[] entry by name
	if (args.model) {
		const entry = cfg.vision.models.find((m) => m.name === args.model);
		if (!entry) {
			fail(
				`--model '${args.model}' not found in vision.models ` +
					`(available: ${cfg.vision.models.map((m) => m.name).join(", ") || "(none)"})`,
			);
		}
		cfg.vision.active = args.model;
	}

	const target = resolveTarget(cfg);
	const maxTokens =
		args.maxTokens ??
		cfg.maxTokens ??
		cfg.legacy?.defaults?.maxTokens ??
		4096;
	const timeoutMs = args.timeout ?? cfg.timeoutMs ?? 300_000;
	const effort =
		args.effort ?? cfg.defaultEffort ?? cfg.legacy?.defaults?.effort ?? "high";

	process.stderr.write(
		`[pi-vision-helper] config=${cfg.path ?? "none"} entry=${target.name} ` +
			`type=${target.type} model=${target.modelId} baseUrl=${target.baseUrl} ` +
			`key=${target.keyFrom} effort=${effort} ` +
			`max_tokens=${maxTokens} timeout=${timeoutMs}\n`,
	);

	const outcome = await runVision(target, {
		images: args.images,
		prompt: args.prompt,
		effort,
		maxTokens,
		timeoutMs,
		systemPrompt: cfg.systemPrompt ?? "",
	});

	process.stderr.write(
		`[pi-vision-helper] model=${outcome.model} status=${outcome.status} ` +
			`usage=${outcome.usage.input}in/${outcome.usage.output}out ` +
			`(${outcome.usage.reasoning} reasoning) ` +
			`cost=${outcome.cost.input}in/${outcome.cost.output}out\n`,
	);

	if (args.json) {
		process.stdout.write(
			JSON.stringify(
				{ model: outcome.model, status: outcome.status, text: outcome.text },
				null,
				2,
			) + "\n",
		);
		return;
	}
	process.stdout.write(outcome.text + "\n");
}

main().catch((e) => {
	fail(e instanceof Error ? e.message : String(e));
});
