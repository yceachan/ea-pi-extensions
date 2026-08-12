/**
 * pi-oc-go-luna-vision extension: registers the `oc-go-luna-vision` tool.
 *
 * Bridges pi to the package's bundled vision.py script, which sends image(s)
 * to the gpt-5.6-luna model (opencode-go provider, OpenAI Responses API) for
 * visual understanding. The heavy lifting stays in vision.py so the tool and
 * the bundled skill behave identically.
 *
 * The script is resolved relative to this file (package-local), so the
 * package works from any install location (npm, git, or local path).
 *
 * Trigger: active provider is opencode-go and the main model's input list has
 * no "image" (e.g. deepseek-v4-flash, glm-5.x, hy3), but the user asks to
 * describe/analyze an image, photo, screenshot, or provides image paths.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VISION_SCRIPT = join(
	PACKAGE_ROOT,
	"skills",
	"oc-go-luna-vision",
	"scripts",
	"vision.py",
);

const MODELS_STORE = join(homedir(), ".pi", "agent", "models-store.json");

const EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

interface LunaCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Look up the luna model's per-M-token cost from models-store.json (fallback: zeros). */
function getLunaCost(): LunaCost {
	try {
		const store = JSON.parse(readFileSync(MODELS_STORE, "utf8")) as {
			[provider: string]: { models?: Array<{ id?: string; cost?: LunaCost }> };
		};
		for (const provider of Object.values(store)) {
			for (const m of provider.models ?? []) {
				if (m.id?.includes("luna")) {
					return m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				}
			}
		}
	} catch {
		// models-store unreadable — report zero cost rather than failing the tool
	}
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Extract "usage=389in/1623out (934 reasoning)" from vision.py stderr. */
function parseUsage(
	stderr: string,
): { input: number; output: number; reasoning: number } | undefined {
	const m = /usage=(\d+)in\/(\d+)out\s*\((\d+) reasoning\)/.exec(stderr);
	if (!m) return undefined;
	return { input: Number(m[1]), output: Number(m[2]), reasoning: Number(m[3]) };
}

function buildUsage(tokens: {
	input: number;
	output: number;
	reasoning: number;
}): Usage {
	const cost = getLunaCost();
	const inputCost = (tokens.input / 1e6) * cost.input;
	const outputCost = (tokens.output / 1e6) * cost.output;
	return {
		input: tokens.input,
		output: tokens.output,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: tokens.reasoning,
		totalTokens: tokens.input + tokens.output,
		cost: {
			input: inputCost,
			output: outputCost,
			cacheRead: 0,
			cacheWrite: 0,
			total: inputCost + outputCost,
		},
	};
}

export default function lunaVisionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "oc-go-luna-vision",
		label: "Luna Vision",
		description:
			"视觉理解：把图片发送给 gpt-5.6-luna 模型（opencode-go provider）识别内容。当主模型不支持图片（input 不含 image，如 deepseek-v4-flash、glm-5.x、hy3、minimax-m2.7）而用户要求描述/分析/识别图片、照片、截图，或给出图片路径时使用。支持 Windows 路径（C:\\Users\\...）与 WSL 路径（/mnt/c/...），支持多图。prompt 必填，必须按用户的具体意图构造（描述、转录文字、对比等），禁止省略。",
		promptSnippet:
			"视觉理解：用 gpt-5.6-luna 识别图片内容（主模型无视觉能力时）",
		promptGuidelines: [
			"Use oc-go-luna-vision when the user asks to describe, analyze, or recognize the content of an image, photo, screenshot, or picture, and the active model cannot see images. Construct the prompt parameter explicitly for the user's specific intent — never omit it.",
		],
		parameters: Type.Object({
			images: Type.Array(
				Type.String({
					description:
						"图片文件路径，支持 Windows（C:\\...）与 WSL（/mnt/...）路径",
				}),
				{ description: "一张或多张图片路径" },
			),
			prompt: Type.String({
				description:
					"必填：针对图片的提问/指令，必须按用户具体意图构造（如'请详细描述这张图片，包括外貌、服装、背景''图中有什么文字？请逐字转录'），禁止省略",
			}),
			effort: Type.Optional(
				StringEnum(EFFORTS, {
					description:
						"思考深度（默认 high）。medium 易产生臆测性幻觉；xhigh/max 会大量消耗输出预算，需同步提高 max_tokens",
				}),
			),
			max_tokens: Type.Optional(
				Type.Integer({
					minimum: 256,
					maximum: 32768,
					description:
						"输出预算，含 reasoning tokens（默认 4096；xhigh/max 建议 8000+）",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}

			const images = (params.images as string[]).map((p: string) =>
				p.startsWith("@") ? p.slice(1) : p,
			);
			const effort = (params.effort ?? "high") as (typeof EFFORTS)[number];
			const maxTokens = params.max_tokens ?? 4096;

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `oc-go-luna-vision: 发送 ${images.length} 张图片到 gpt-5.6-luna (effort=${effort}, max_tokens=${maxTokens})...`,
					},
				],
				details: { progress: 50 },
			});

			const result = await pi.exec(
				"python3",
				[
					VISION_SCRIPT,
					...images,
					"--prompt",
					params.prompt as string,
					"--effort",
					effort,
					"--max-tokens",
					String(maxTokens),
				],
				{ signal, timeout: 300_000 },
			);

			if (result.code !== 0) {
				const detail = (
					result.stderr ||
					result.stdout ||
					"unknown error"
				).trim();
				throw new Error(
					`oc-go-luna-vision failed (exit ${result.code}): ${detail}`,
				);
			}

			const tokens = parseUsage(result.stderr);

			return {
				content: [{ type: "text", text: result.stdout.trim() }],
				details: {
					model: "gpt-5.6-luna",
					status: "completed",
					effort,
					imageCount: images.length,
				},
				usage: tokens ? buildUsage(tokens) : undefined,
			};
		},
	});
}
