/**
 * pi-vision-helper extension: registers the `pi-vision-helper` tool.
 *
 * Sends image(s) to a configurable vision model (OpenAI Responses API) when
 * the main model cannot see images. All logic lives in ../lib (config
 * resolution, pi-registry / custom-API sourcing, request round trip) and runs
 * in-process — single runtime, no python subprocess.
 *
 * Config (first found wins):
 *   --config is not exposed as a tool param; resolution is
 *   $PI_VISION_HELPER_CONFIG > $CWD/.pi/vision-helper.json >
 *   ~/.pi/agent/pi-vision-helper.json. See skills/pi-vision-helper/SKILL.md
 *   for the full schema (enabled / forceVisionBridge / maxTokens / timeoutMs /
 *   systemPrompt / vision.models[] with pi-registry + responses entries).
 *
 * Trigger: the main model's input list has no "image" (e.g.
 * deepseek-v4-flash, glm-5.x, hy3, minimax-m2.7), but the user asks to
 * describe/analyze an image, photo, screenshot, or provides image paths.
 * (forceVisionBridge=true lifts the trigger restriction: the tool may be
 * used even when the main model is itself a VLM.)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Usage } from "@earendil-works/pi-ai";
import { loadConfig } from "../lib/config";
import {
	DEFAULT_MAX_TOKENS,
	DEFAULT_TIMEOUT_MS,
	EFFORTS,
	resolveTarget,
	runVision,
	type VisionOutcome,
} from "../lib/vision";

function buildUsage(outcome: VisionOutcome): Usage {
	return {
		input: outcome.usage.input,
		output: outcome.usage.output,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: outcome.usage.reasoning,
		totalTokens: outcome.usage.input + outcome.usage.output,
		cost: {
			input: outcome.cost.input,
			output: outcome.cost.output,
			cacheRead: 0,
			cacheWrite: 0,
			total: outcome.cost.input + outcome.cost.output,
		},
	};
}

export default function piVisionHelperExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi-vision-helper",
		label: "Vision Helper",
		description:
			"视觉理解：把图片发送给视觉模型（OpenAI Responses API）识别内容，当主模型不支持图片（input 不含 image，如 deepseek-v4-flash、glm-5.x、hy3、minimax-m2.7）而用户要求描述/分析/识别图片、照片、截图，或给出图片路径时使用。模型/API 由配置驱动：$CWD/.pi/vision-helper.json 或 ~/.pi/agent/pi-vision-helper.json（vision.models 列表，pi-registry 复用或 responses 自定义 API，vision.active 指定激活模型；缺省=pi-registry 首个 luna）。配置 enabled=false 时工具拒绝运行；forceVisionBridge=true 时主模型即使是 VLM 也可调用。支持 Windows 路径（C:\\Users\\...）与 WSL 路径（/mnt/c/...），支持多图。prompt 必填，必须按用户的具体意图构造（描述、转录文字、对比等），禁止省略。",
		promptSnippet: "视觉理解：用视觉模型识别图片内容（主模型无视觉能力时）",
		promptGuidelines: [
			"Use pi-vision-helper when the user asks to describe, analyze, or recognize the content of an image, photo, screenshot, or picture, and the active model cannot see images. Construct the prompt parameter explicitly for the user's specific intent — never omit it.",
		],
		parameters: Type.Object({
			images: Type.Array(
				Type.String({
					description: "图片文件路径，支持 Windows（C:\\...）与 WSL（/mnt/...）路径",
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
						"输出预算，含 reasoning tokens（默认取配置 maxTokens，未配置时 4096；xhigh/max 建议 8000+）",
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

			let cfg;
			try {
				cfg = loadConfig({ cwd: ctx.cwd });
			} catch (e) {
				throw new Error(
					`pi-vision-helper config error: ${e instanceof Error ? e.message : e}`,
				);
			}
			if (!cfg.enabled) {
				return {
					content: [
						{
							type: "text",
							text: "pi-vision-helper 已在配置中禁用（enabled=false）。",
						},
					],
					details: { enabled: false, config: cfg.path },
				};
			}

			const target = resolveTarget(cfg);
			const maxTokens =
				(params.max_tokens as number | undefined) ??
				cfg.maxTokens ??
				cfg.legacy?.defaults?.maxTokens ??
				DEFAULT_MAX_TOKENS;
			const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `pi-vision-helper: 发送 ${images.length} 张图片到 ${target.name} (${target.type}, ${target.modelId})...`,
					},
				],
				details: { progress: 50 },
			});

			let outcome: VisionOutcome;
			try {
				outcome = await runVision(target, {
					images,
					prompt: params.prompt as string,
					effort: params.effort as string | undefined,
					maxTokens,
					timeoutMs,
					systemPrompt: cfg.systemPrompt ?? "",
				});
			} catch (e) {
				throw new Error(
					`pi-vision-helper failed: ${e instanceof Error ? e.message : e}`,
				);
			}

			return {
				content: [{ type: "text", text: outcome.text }],
				details: {
					model: outcome.model,
					status: outcome.status,
					entry: target.name,
					type: target.type,
					config: cfg.path,
					effort: params.effort ?? "high",
					imageCount: images.length,
					keyFrom: target.keyFrom,
				},
				usage: buildUsage(outcome),
			};
		},
	});
}
