/**
 * Unit tests for the pure helpers in lib/ (registry fuzzy matching, path
 * conversion, cost accounting, config parsing, target resolution).
 * Run with: node lib/vision-helper.test.ts  (node >= 23.6, type stripping)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyPick } from "./registry.ts";
import { computeCost, resolveImagePath, resolveTarget } from "./vision.ts";
import { CONFIG_ENV, findConfigPath, loadConfig } from "./config.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.log(
			`FAIL  ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
		);
	}
}

function checkThrows(name: string, fn: () => unknown, expected: string) {
	try {
		fn();
		console.log(`FAIL  ${name}\n      expected throw matching: ${expected}`);
		failures++;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes(expected)) {
			console.log(`  ok  ${name}`);
		} else {
			console.log(
				`FAIL  ${name}\n      expected throw matching: ${expected}\n      actual:   ${msg}`,
			);
			failures++;
		}
	}
}

// --- fuzzyPick: exact > candidate contains needle > needle contains candidate > undefined ---
const candidates = ["opencode-go", "openrouter", "anthropic", "deepseek"];
check("fuzzy exact (case-insensitive)", fuzzyPick("OPEncode-Go", candidates), "opencode-go");
check("fuzzy candidate contains needle", fuzzyPick("open", candidates), "opencode-go");
check("fuzzy needle contains candidate", fuzzyPick("opencode-go-gateway", candidates), "opencode-go");
check("fuzzy no match = undefined", fuzzyPick("zzz", candidates), undefined);
check("fuzzy empty candidates", fuzzyPick("x", []), undefined);
check(
	"fuzzy exact beats contains",
	fuzzyPick("anthropic", ["anthropic-eval", "anthropic"]),
	"anthropic",
);

// --- resolveImagePath ---
const root = join(tmpdir(), `pi-vision-helper-test-${process.pid}`);
mkdirSync(join(root, ".pi"), { recursive: true });
const img = join(root, "pic.png");
writeFileSync(img, "fake-png-bytes");

check("existing path passes through", resolveImagePath(img), img);
check("existing path trimmed", resolveImagePath(`  ${img}  `), img);
checkThrows(
	"wsl-style path used as-is (no conversion)",
	() => resolveImagePath("/mnt/c/x/y.png"),
	"image not found: /mnt/c/x/y.png",
);
checkThrows(
	"missing plain path",
	() => resolveImagePath("/no/such/file.png"),
	"image not found: /no/such/file.png",
);
checkThrows(
	"windows path converts to /mnt/<drive>",
	() => resolveImagePath("C:\\no\\such\\pic.png"),
	"(also tried /mnt/c/no/such/pic.png)",
);
checkThrows(
	"windows path trimmed before convert",
	() => resolveImagePath("  C:\\no\\such\\pic.png "),
	"/mnt/c/no/such/pic.png",
);
checkThrows(
	"windows lowercase drive converts",
	() => resolveImagePath("d:\\tmp\\x.png"),
	"/mnt/d/tmp/x.png",
);

// --- computeCost ---
check("cost per-M-token formula", computeCost(
	{ input: 1_000_000, output: 500_000 },
	{ input: 2, output: 10 },
), { input: 2, output: 5 });
check("cost fractional tokens", computeCost(
	{ input: 1000, output: 0 },
	{ input: 0.1, output: 0.6 },
), { input: 0.0001, output: 0 });
check("cost zero usage", computeCost(
	{ input: 0, output: 0 },
	{ input: 2, output: 10 },
), { input: 0, output: 0 });

// --- findConfigPath / loadConfig ---
const explicit = join(root, "explicit.json");
const envPath = join(root, "env.json");
const projectCfg = join(root, ".pi", "vision-helper.json");
const oldEnv = process.env[CONFIG_ENV];
try {
	// env var config
	writeFileSync(envPath, JSON.stringify({ enabled: false }));
	process.env[CONFIG_ENV] = envPath;
	const envCfg = loadConfig();
	check("env var config wins", envCfg.enabled, false);
	check("env var config path recorded", envCfg.path, envPath);
	delete process.env[CONFIG_ENV];

	// project-level config (cwd candidate)
	writeFileSync(
		projectCfg,
		JSON.stringify({
			enabled: true,
			forceVisionBridge: true,
			defaultEffort: "xhigh",
			maxTokens: 8000,
			timeoutMs: 120000,
			systemPrompt: "custom",
			vision: {
				active: "luna-customer",
				models: [
					{
						name: "luna",
						type: "pi-registry",
						provider: "opencode-go",
						model: "gpt-5.6-luna",
						cost: { input: 0.1, output: 0.6, cacheRead: 0.01 },
						headers: { "X-Foo": "bar" },
					},
					{
						name: "luna-customer",
						type: "responses",
						baseUrl: "https://opencode.ai/zen/go/v1",
						apiKey: "sk-literal",
						model: "gpt-5.6-luna",
						headers: { "X-Bar": "baz" },
					},
				],
			},
		}),
	);
	const proj = loadConfig({ cwd: root });
	check("project config found via cwd", proj.path, projectCfg);
	check("enabled default", proj.enabled, true);
	check("forceVisionBridge parsed", proj.forceVisionBridge, true);
	check("defaultEffort parsed", proj.defaultEffort, "xhigh");
	check("maxTokens parsed", proj.maxTokens, 8000);
	check("timeoutMs parsed", proj.timeoutMs, 120000);
	check("systemPrompt parsed", proj.systemPrompt, "custom");
	check("vision.active parsed", proj.vision.active, "luna-customer");
	check("vision.models length", proj.vision.models.length, 2);
	check(
		"pi-registry entry cost parsed",
		proj.vision.models[0].cost,
		{ input: 0.1, output: 0.6, cacheRead: 0.01 },
	);
	check("pi-registry entry headers parsed", proj.vision.models[0].headers, { "X-Foo": "bar" });
	check("responses entry headers parsed", proj.vision.models[1].headers, { "X-Bar": "baz" });
	check("no legacy block when vision present", proj.legacy, undefined);

	// explicit path wins over everything
	writeFileSync(explicit, JSON.stringify({ maxTokens: 1024 }));
	const exp = loadConfig({ explicit, cwd: root });
	check("explicit path wins", exp.path, explicit);
	check("explicit path parsed", exp.maxTokens, 1024);

	// empty config → built-in defaults
	const empty = join(root, "empty.json");
	writeFileSync(empty, "{}");
	const emptyCfg = loadConfig({ explicit: empty });
	check("empty config enabled", emptyCfg.enabled, true);
	check("empty config forceVisionBridge", emptyCfg.forceVisionBridge, false);
	check("empty config defaultEffort", emptyCfg.defaultEffort, undefined);
	check("empty config vision.models", emptyCfg.vision.models, []);
	check("empty config legacy", emptyCfg.legacy, undefined);

	// legacy flat fields still normalize
	const legacy = join(root, "legacy.json");
	writeFileSync(
		legacy,
		JSON.stringify({
			provider: "opencode-go",
			model: "gpt-5.6-luna",
			modelMatch: "substring",
			cost: { input: 0.1, output: 0.6 },
			headers: { "X-Legacy": "1" },
			defaults: { effort: "medium", maxTokens: "4096" },
		}),
	);
	const legCfg = loadConfig({ explicit: legacy });
	check("legacy provider parsed", legCfg.legacy?.provider, "opencode-go");
	check("legacy modelMatch parsed", legCfg.legacy?.modelMatch, "substring");
	check("legacy cost parsed", legCfg.legacy?.cost, { input: 0.1, output: 0.6 });
	check("legacy headers parsed", legCfg.legacy?.headers, { "X-Legacy": "1" });
	check("legacy defaults.effort parsed", legCfg.legacy?.defaults?.effort, "medium");
	check("legacy defaults.maxTokens normalized to number", legCfg.legacy?.defaults?.maxTokens, 4096);
	check("legacy leaves vision.models empty", legCfg.vision.models, []);

	// config errors
	checkThrows(
		"missing explicit config",
		() => loadConfig({ explicit: join(root, "nope.json") }),
		"does not exist",
	);
	const badJson = join(root, "bad.json");
	writeFileSync(badJson, "{ not json");
	checkThrows("invalid json", () => loadConfig({ explicit: badJson }), "cannot read");
	const notObj = join(root, "notobj.json");
	writeFileSync(notObj, "[1,2]");
	checkThrows("non-object config", () => loadConfig({ explicit: notObj }), "must be a JSON object");

	const badModel = join(root, "badmodel.json");
	writeFileSync(
		badModel,
		JSON.stringify({ vision: { models: [{ type: "bogus" }] } }),
	);
	checkThrows(
		"bad model type",
		() => loadConfig({ explicit: badModel }),
		"must be 'pi-registry' or 'responses'",
	);
	const badLegacy = join(root, "badlegacy.json");
	writeFileSync(badLegacy, JSON.stringify({ provider: "opencode-go", modelMatch: "fuzzy" }));
	checkThrows(
		"bad modelMatch",
		() => loadConfig({ explicit: badLegacy }),
		"modelMatch must be",
	);
	const badEffort = join(root, "badeffort.json");
	writeFileSync(badEffort, JSON.stringify({ defaultEffort: "turbo" }));
	checkThrows(
		"bad defaultEffort",
		() => loadConfig({ explicit: badEffort }),
		"defaultEffort must be one of",
	);
	const legacyBadEffort = join(root, "legacybadeffort.json");
	writeFileSync(
		legacyBadEffort,
		JSON.stringify({ defaults: { effort: "turbo" } }),
	);
	checkThrows(
		"bad legacy defaults.effort",
		() => loadConfig({ explicit: legacyBadEffort }),
		"defaults.effort must be one of",
	);
	const minimalEffort = join(root, "minimaleffort.json");
	writeFileSync(minimalEffort, JSON.stringify({ defaultEffort: "minimal" }));
	check(
		"defaultEffort minimal accepted",
		loadConfig({ explicit: minimalEffort }).defaultEffort,
		"minimal",
	);
	const legacyMinimalEffort = join(root, "legacyminimaleffort.json");
	writeFileSync(
		legacyMinimalEffort,
		JSON.stringify({ defaults: { effort: "minimal" } }),
	);
	check(
		"legacy defaults.effort minimal accepted",
		loadConfig({ explicit: legacyMinimalEffort }).legacy?.defaults?.effort,
		"minimal",
	);
	const bigTokens = join(root, "bigtokens.json");
	writeFileSync(bigTokens, JSON.stringify({ maxTokens: 99999 }));
	checkThrows(
		"maxTokens above bound",
		() => loadConfig({ explicit: bigTokens }),
		"maxTokens must be between 256 and 32768",
	);
	const legacyBigTokens = join(root, "legacybigtokens.json");
	writeFileSync(
		legacyBigTokens,
		JSON.stringify({ defaults: { maxTokens: 100 } }),
	);
	checkThrows(
		"legacy defaults.maxTokens below bound",
		() => loadConfig({ explicit: legacyBigTokens }),
		"defaults.maxTokens must be between",
	);
	const badCost = join(root, "badcost.json");
	writeFileSync(
		badCost,
		JSON.stringify({ vision: { models: [{ name: "x", cost: { input: "abc" } }] } }),
	);
	checkThrows(
		"non-numeric cost",
		() => loadConfig({ explicit: badCost }),
		"cost.input must be a number",
	);

	// findConfigPath: explicit beats env, env beats cwd
	process.env[CONFIG_ENV] = envPath;
	check("explicit beats env", findConfigPath({ explicit, cwd: root }), explicit);
	check("env beats cwd", findConfigPath({ cwd: root }), envPath);
	delete process.env[CONFIG_ENV];
	check("cwd project config", findConfigPath({ cwd: root }), projectCfg);
} finally {
	if (oldEnv === undefined) delete process.env[CONFIG_ENV];
	else process.env[CONFIG_ENV] = oldEnv;
}

// --- resolveTarget: vision.active handling (responses entries = hermetic) ---
const activeCfg = join(root, "active.json");
writeFileSync(
	activeCfg,
	JSON.stringify({
		vision: {
			active: "second",
			models: [
				{
					name: "first",
					type: "responses",
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "sk-a",
					model: "gpt-5.6-luna",
					cost: { input: 0.1, output: 0.6 },
				},
				{
					name: "second",
					type: "responses",
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "sk-b",
					model: "kimi-k2.7-code",
					cost: { input: 0.1, output: 0.6 },
				},
			],
		},
	}),
);
const activeTarget = resolveTarget(loadConfig({ explicit: activeCfg }));
check("vision.active selects named entry", activeTarget.name, "second");
check("responses entry keyFrom literal", activeTarget.keyFrom, "config apiKey");
check("responses entry cost override", activeTarget.cost, { input: 0.1, output: 0.6 });

const noActiveCfg = join(root, "noactive.json");
writeFileSync(
	noActiveCfg,
	JSON.stringify({
		vision: {
			models: [
				{
					name: "first",
					type: "responses",
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "sk-a",
					model: "gpt-5.6-luna",
				},
			],
		},
	}),
);
const noActiveTarget = resolveTarget(loadConfig({ explicit: noActiveCfg }));
check("absent vision.active picks first entry", noActiveTarget.name, "first");

const badActiveCfg = join(root, "badactive.json");
writeFileSync(
	badActiveCfg,
	JSON.stringify({
		vision: {
			active: "ghost",
			models: [
				{
					name: "first",
					type: "responses",
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "sk-a",
					model: "gpt-5.6-luna",
				},
			],
		},
	}),
);
checkThrows(
	"unknown vision.active errors with available names",
	() => resolveTarget(loadConfig({ explicit: badActiveCfg })),
	"vision.active 'ghost' not found in vision.models — available names: first",
);

// cleanup
rmSync(root, { recursive: true, force: true });

console.log(
	failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
