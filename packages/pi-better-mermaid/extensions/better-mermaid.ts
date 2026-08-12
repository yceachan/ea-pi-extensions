/**
 * pi-better-mermaid extension: registers the `better-mermaid` tool.
 *
 * Workflow (agent-driven retry loop, see .agents/docs/adr/0001):
 *   tool call → agent reads the bundled better-mermaid skill once (knowledge
 *   injection, per-call-sequence contract) → agent clarifies the modeling
 *   intent, produces the mermaid code and delivers it here → harness validates
 *   (hardcoded lint rules ①③⑤+rect, then mmdc syntax/render) → pass ends the
 *   call; fail returns structured errors for the agent to fix and resubmit.
 *
 * Harness state is minimal: one per-session consecutive-failure counter.
 * After 3 consecutive failures the next call returns an `exhausted` outcome
 * (accumulated error history + re-modeling guidance) to give the agent new
 * reasoning space instead of blind retries (ADR-0001). Counter resets on pass
 * or when the intent changes.
 *
 * mmdc (mermaid-cli) is a global peer dependency (ADR-0002): resolved from
 * PATH, version-probed once per process; a version != 11.15.0 only warns.
 *
 * The bundled `better-mermaid` skill (skills/better-mermaid/) is a renamed
 * same-source copy of the writing-mermaid skill and is the tool's only
 * knowledge source (ADR-0003).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_FAILURES = 3;
const EXPECTED_MMDC_VERSION = "11.15.0";
const MM_DC_TIMEOUT_MS = 60_000;

/** Normalize a declared or actual diagram type to a canonical token. */
const TYPE_ALIASES: Record<string, string> = {
	sequence: "sequenceDiagram",
	sequenceDiagram: "sequenceDiagram",
	state: "stateDiagram-v2",
	stateDiagram: "stateDiagram-v2",
	stateDiagramV2: "stateDiagram-v2",
	class: "classDiagram",
	classDiagram: "classDiagram",
	er: "erDiagram",
	erDiagram: "erDiagram",
	flowchart: "flowchart",
	graph: "flowchart",
	requirement: "requirementDiagram",
	requirementDiagram: "requirementDiagram",
	eventmodeling: "eventmodeling",
	gitGraph: "gitGraph",
	timeline: "timeline",
	gantt: "gantt",
	mindmap: "mindmap",
	c4: "C4Context",
	c4context: "C4Context",
	C4Context: "C4Context",
	block: "block-beta",
	blockBeta: "block-beta",
	journey: "journey",
	quadrant: "quadrantChart",
	quadrantChart: "quadrantChart",
	sankey: "sankey-beta",
	"sankey-beta": "sankey-beta",
	xychart: "xychart-beta",
	"xychart-beta": "xychart-beta",
};

function normalizeType(t: string): string {
	const key = t.trim().replace(/\s+/g, "");
	return TYPE_ALIASES[key] ?? key.toLowerCase();
}

interface LintViolation {
	rule: string;
	line?: number;
	message: string;
}

/**
 * v1 lint boundary (see .agents/docs/context.md — 机器可查边界):
 * ① `;` outside `%%{...}%%` frontmatter  ③ sequenceDiagram without autonumber
 * ⑤ declared type vs diagram header mismatch   + rect rgb() channel <= 200
 * Semantic rules (type appropriateness, granularity, advanced syntax) are left
 * to the agent's self-audit via the skill's self-check — not machine-checked.
 */
function lint(code: string, declaredType?: string): LintViolation[] {
	const violations: LintViolation[] = [];

	// ① semicolons, ignoring %%{...}%% config frontmatter
	const noFrontmatter = code.replace(/%%\{[\s\S]*?\}%%/g, "");
	const semicolonLines = noFrontmatter
		.split("\n")
		.map((line, i) => ({ line: i + 1, hasSemicolon: line.includes(";") }))
		.filter((l) => l.hasSemicolon);
	for (const l of semicolonLines) {
		violations.push({
			rule: "no-semicolon",
			line: l.line,
			message: `第 ${l.line} 行含 ";" — skill 硬规则：禁用分号，用换行或 <br/> 替代`,
		});
	}

	// diagram header: first non-empty line after frontmatter
	const lines = code.split("\n");
	let header = "";
	for (const line of lines) {
		const t = line.trim();
		if (!t || t.startsWith("%%{")) continue;
		header = t;
		break;
	}
	const actualType = header.split(/\s+/)[0] ?? "";

	// ③ sequenceDiagram must carry autonumber
	if (/^sequenceDiagram\b/.test(actualType) && !/\bautonumber\b/.test(code)) {
		violations.push({
			rule: "sequence-autonumber",
			line: 1,
			message: `sequenceDiagram 必须以 autonumber 开头（skill 硬规则：编号消息是正文引用图的锚点）`,
		});
	}

	// ⑤ declared type vs header
	if (
		declaredType &&
		normalizeType(declaredType) !== normalizeType(actualType)
	) {
		violations.push({
			rule: "type-header-mismatch",
			line: 1,
			message: `声明 type="${declaredType}"，但图头是 "${actualType}" — 两者必须一致`,
		});
	}

	// rect rgb(R,G,B) — every channel must be > 200 (light background blocks)
	const rectRe = /rect\s+rgb\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/g;
	for (let i = 0; i < lines.length; i++) {
		const m = rectRe.exec(lines[i]);
		rectRe.lastIndex = 0;
		if (m) {
			const channels = [Number(m[1]), Number(m[2]), Number(m[3])];
			if (channels.some((c) => c <= 200)) {
				violations.push({
					rule: "rect-light",
					line: i + 1,
					message: `rect rgb(${channels.join(",")}) 含 <=200 的通道 — 浅色背景块规则：每个通道必须 > 200`,
				});
			}
		}
	}

	return violations;
}

/** Strip a wrapping ```mermaid ... ``` fence if present. */
function stripFences(code: string): string {
	const trimmed = code.trim();
	const fence = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
	return fence ? fence[1].trim() : trimmed;
}

/** Extract "Parse error on line N" from mmdc stderr. */
function extractParseError(stderr: string): { line?: number; excerpt: string } {
	const lineMatch = /Parse error on line (\d+)/.exec(stderr);
	const excerpt = stderr
		.replace(/^Generating single mermaid chart\s*\n*/m, "")
		.trim()
		.slice(0, 800);
	return { line: lineMatch ? Number(lineMatch[1]) : undefined, excerpt };
}

interface SessionState {
	intent: string;
	failures: number;
	history: string[];
}

const stateBySession = new Map<string, SessionState>();

// mmdc version probe — once per process (module-level cache)
let mmdcVersion: string | undefined;
let mmdcProbeError: string | undefined;
let mmdcProbeDone = false;

export default function betterMermaidExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "better-mermaid",
		label: "Better Mermaid",
		description:
			"mermaid 图交付校验工具：agent 按捆绑的 better-mermaid skill 产出图，交付给本工具做 mmdc 语法/渲染校验 + 硬规则 lint（无分号、sequence 有 autonumber、type 与图头一致、rect rgb>200）。通过则返回渲染产物 SVG；失败返回结构化错误（行号 + 摘要 + lint 违规 + 尝试计数）供 agent 修改后再次调用；连续 3 次失败返回 exhausted 结果（累计错误历史 + 重新建模指引）。",
		promptSnippet:
			"交付并校验 mermaid 图（mmdc 门禁 + 硬规则 lint，结构化错误循环修复）",
		promptGuidelines: [
			"Use better-mermaid when the user asks for a mermaid diagram (图/流程图/时序图/状态机/类图/架构图/ER图/mindmap/gantt/timeline…) that must render reliably.",
			"Before your FIRST better-mermaid call in a call sequence, read the bundled better-mermaid skill: SKILL.md, the matching references/types/<type>.md, and references/encoded-preferences.md. During retry loops do NOT re-read the skill — fix from the structured errors only.",
			"Fill intent with the modeling intent in one sentence (what invariant/sequence/structure/state-transition the diagram makes legible — the skill's workflow step 1). Pick the type from the skill's type table; the type parameter must match the diagram's first line.",
			"Self-audit before delivering (skill self-check): type appropriateness, no god nodes, at least one advanced-syntax feature, encoding rules.",
			"After 3 consecutive failed validations better-mermaid returns an exhausted result — stop retrying, rethink the modeling (different diagram type, consult the skill reference, or ask the user), and only resubmit a genuinely revised diagram.",
		],
		parameters: Type.Object({
			intent: Type.String({
				description:
					"必填：一句话建模意图——这张图要让什么不变式/时序/结构/状态迁移变得清晰可读（对应 skill 工作流第 1 步）",
			}),
			type: Type.Optional(
				Type.String({
					description:
						"可选：期望的图类型（sequenceDiagram / stateDiagram-v2 / classDiagram / erDiagram / flowchart / requirementDiagram / gitGraph / timeline / gantt / mindmap / C4Context / block / journey / quadrantChart / sankey-beta / xychart-beta / eventmodeling（已弃用，11.15.0 渲染错误页））。lint 会校验其与代码图头一致",
				}),
			),
			mermaid: Type.String({
				description:
					"必填：待校验的 mermaid 代码（可带 ```mermaid 围栏，会被剥离）",
			}),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}

			const code = stripFences(params.mermaid as string);
			const declaredType = params.type as string | undefined;
			const sessionKey = ctx.sessionManager.getSessionId() ?? "default";

			// --- counter state (resets on intent change or pass) ---
			let state = stateBySession.get(sessionKey);
			if (!state || state.intent !== params.intent) {
				state = { intent: params.intent as string, failures: 0, history: [] };
				stateBySession.set(sessionKey, state);
			}

			// --- lint (short-circuits mmdc — encoding violations would fail rendering anyway) ---
			const violations = lint(code, declaredType);
			if (violations.length > 0) {
				return fail(state, violations, undefined);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: "better-mermaid: lint 通过，mmdc 渲染校验中...",
					},
				],
				details: { progress: 50 },
			});

			// --- mmdc version probe (once per process) ---
			let versionWarning: string | undefined;
			if (!mmdcProbeDone) {
				mmdcProbeDone = true;
				try {
					const probe = await pi.exec("mmdc", ["--version"], {
						signal,
						timeout: 15_000,
					});
					if (probe.code === 0) {
						mmdcVersion = probe.stdout.trim();
						if (mmdcVersion !== EXPECTED_MMDC_VERSION) {
							versionWarning = `mmdc 版本 ${mmdcVersion} ≠ skill 锁定引擎 ${EXPECTED_MMDC_VERSION}（v11.x+ 语法可用性不保证）`;
						}
					} else {
						mmdcProbeError = (probe.stderr || probe.stdout || "")
							.trim()
							.slice(0, 300);
					}
				} catch (error) {
					mmdcProbeError =
						error instanceof Error
							? error.message.slice(0, 300)
							: String(error);
				}
			}
			if (mmdcVersion === undefined) {
				throw new Error(
					`better-mermaid: 全局 mmdc（mermaid-cli）不可用${mmdcProbeError ? `：${mmdcProbeError}` : ""}。请安装：npm i -g @mermaid-js/mermaid-cli@11.15.0`,
				);
			}

			// --- run mmdc on a temp dir ---
			const dir = mkdtempSync(join(tmpdir(), "pi-better-mermaid-"));
			const mmdPath = join(dir, "diagram.mmd");
			const svgPath = join(dir, "diagram.svg");
			writeFileSync(mmdPath, code, "utf8");

			const startedAt = Date.now();
			const result = await pi.exec("mmdc", ["-i", mmdPath, "-o", svgPath], {
				signal,
				timeout: MM_DC_TIMEOUT_MS,
			});
			const durationMs = Date.now() - startedAt;

			if (result.code === 0) {
				// Gate the gate: mmdc can exit 0 while the SVG is a mermaid
				// error page (eventmodeling on 11.15.0 renders exactly that).
				// "Rendered" != "rendered correctly" — treat error pages as failures.
				// Match the actual error <text> element / message, not the CSS rule
				// `.error-text{...}` that ships in every mermaid SVG template.
				const svg = readFileSync(svgPath, "utf8");
				if (/Syntax error in text|<text[^>]*class="error-text"/.test(svg)) {
					return fail(state, [], {
						excerpt:
							"mmdc exited 0 but the SVG is a mermaid error page — renderer failed (eventmodeling is deprecated on 11.15.0)",
					});
				}
				stateBySession.delete(sessionKey);
				const warning = versionWarning ? `\n⚠️ ${versionWarning}` : "";
				return {
					content: [
						{
							type: "text",
							text: `✅ better-mermaid: check passed（第 ${state.failures + 1} 次尝试，mmdc ${durationMs}ms）\nSVG: ${svgPath}\nMMD: ${mmdPath}${warning}`,
						},
					],
					details: {
						status: "passed",
						attempts: state.failures + 1,
						svgPath,
						mmdPath,
						durationMs,
						mmdcVersion,
						...(versionWarning ? { warning: versionWarning } : {}),
					},
				};
			}

			const parseError = extractParseError(
				result.stderr || result.stdout || "",
			);
			const summary = parseError.line
				? `mmdc 解析错误（第 ${parseError.line} 行）: ${parseError.excerpt.split("\n")[0]}`
				: `mmdc 渲染失败: ${(result.stderr || result.stdout || "unknown error").trim().slice(0, 300)}`;
			return fail(state, [], { ...parseError, summary });
		},
	});

	/** Shared failure path: bump the counter, then fail or exhaust. */
	function fail(
		state: SessionState,
		violations: LintViolation[],
		parseError:
			| { line?: number; excerpt?: string; summary?: string }
			| undefined,
	): AgentToolResult<unknown> {
		state.failures += 1;
		const attempt = state.failures;

		let detail = "";
		if (violations.length > 0) {
			detail = violations
				.map(
					(v) => `[${v.rule}]${v.line ? ` 第 ${v.line} 行` : ""}: ${v.message}`,
				)
				.join("\n");
		} else if (parseError) {
			detail = parseError.summary ?? parseError.excerpt ?? "未知错误";
		}
		state.history.push(`第 ${attempt} 次: ${detail.split("\n")[0]}`);

		const attemptNote = `（第 ${attempt}/${MAX_FAILURES} 次尝试）`;
		if (state.failures < MAX_FAILURES) {
			return {
				content: [
					{
						type: "text",
						text: `❌ better-mermaid: 校验未通过 ${attemptNote}\n\n${detail}\n\n按结构化错误修复后再次调用（每次调用返回完整错误，不依赖跨调用状态）。`,
					},
				],
				details: {
					status: "failed",
					attempts: attempt,
					remaining: MAX_FAILURES - attempt,
					...(violations.length > 0 ? { lint: violations } : {}),
					...(parseError ? { parseError } : {}),
				},
			};
		}

		// exhausted: give the agent new reasoning space, then reset the counter
		const history = [...state.history];
		state.failures = 0;
		state.history = [];

		return {
			content: [
				{
					type: "text",
					text: `🛑 better-mermaid: 连续 ${MAX_FAILURES} 次校验未通过，停止重试\n\n累计错误：\n${history.join("\n")}\n\n重新建模指引（给新的推理空间）：\n- 重新考虑图类型（换一种更贴切的类型，参考 better-mermaid skill 的 references/types/）\n- 重读对应类型的深潜文件后再产图\n- 或向用户确认建模意图本身是否成立\n\n确认有实质性修订后再提交（intent 变化会自动重置计数）。`,
				},
			],
			details: { status: "exhausted", attempts: MAX_FAILURES, history },
		};
	}
}
