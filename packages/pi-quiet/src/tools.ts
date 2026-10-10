/**
 * Quiet Display rendering for tools.
 *
 * Two registration paths:
 * - Preferred: Pi registerToolRenderer wrapper for every tool (built-in + Foreign).
 * - Fallback: registerTool overrides for the seven built-ins only (no Foreign Quiet).
 *
 * Execution always stays on the original tool definition.
 */

import type {
	AgentToolResult,
	EditToolDetails,
	ExtensionAPI,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { createQuietBashToolDefinitionFactory } from "./bash-settings.ts";
import {
	type QuietOutcome,
	classifyQuietTool,
	textLineCount,
} from "./classify.ts";
import type { CompactionIndex } from "./compaction.ts";
import {
	displayTargets,
	formatGroupHeader,
	formatMemberBullet,
	formatMemberSummary,
	formatQuietResultLines,
	formatSingletonCallLine,
	groupKindForTool,
} from "./format.ts";
import {
	resultIsImageFromContent,
	resultTextFromContent,
} from "./result-content.ts";
import {
	TOOL_SHELL_PADDING,
	type ToolShellBg,
	toolShellBgForQuietOutcome,
	toolShellBgForStock,
} from "./shell.ts";
import {
	type StockToolRenderers,
	type ToolRenderContext,
	type ToolRendererWrapper,
	tryRegisterToolRenderer,
} from "./tool-renderer-api.ts";
import type { QuietToolName } from "./tools-meta.ts";
import { setForeignToolsQuiet } from "./tools-meta.ts";

type AnyDef = ToolDefinition<any, any, any>;
type ThemeColor = "error" | "muted" | "success" | "dim" | "warning" | "toolTitle";

/** Per-tool-execution renderer state (shared call + result via context.state). */
type ShellState = {
	shellBox?: Box;
	/** Isolated lastComponent for delegated Stock call renderer. */
	stockCall?: Component;
	/** Isolated lastComponent for delegated Stock result renderer. */
	stockResult?: Component;
	/** Nested state object passed into Stock result renderers. */
	stockResultState?: Record<string, unknown>;
};

type StockFns = {
	/** When true, Quiet-off leaves shell ownership to Stock (e.g. edit). */
	stockSelfShell?: boolean;
	renderCall?: StockToolRenderers["renderCall"];
	renderResult?: StockToolRenderers["renderResult"];
	/** Fallback title when Stock has no renderCall. */
	fallbackTitle: string;
};

function resultText(result: AgentToolResult<unknown>): string {
	return resultTextFromContent(result.content);
}

function resultIsImage(result: AgentToolResult<unknown>): boolean {
	return resultIsImageFromContent(result.content);
}

function colorForOutcome(kind: QuietOutcome["kind"]): ThemeColor {
	switch (kind) {
		case "hard":
			return "error";
		case "soft":
			return "muted";
		case "pending":
			return "dim";
		default:
			return "success";
	}
}

function emptyComponent(): Text {
	return new Text("", 0, 0);
}

function shellState(context: ToolRenderContext<unknown, unknown>): ShellState {
	return context.state as ShellState;
}

function getShellBox(context: ToolRenderContext<unknown, unknown>): Box {
	const state = shellState(context);
	if (state.shellBox) return state.shellBox;
	const box = new Box(TOOL_SHELL_PADDING, TOOL_SHELL_PADDING);
	state.shellBox = box;
	return box;
}

function paintShell(box: Box, theme: Theme, bg: ToolShellBg): void {
	box.setBgFn((text) => theme.bg(bg, text));
}

function resetShell(box: Box, theme: Theme, bg: ToolShellBg): void {
	paintShell(box, theme, bg);
	box.clear();
}

/**
 * Keep the call/header child from renderCall; drop prior result children.
 * Pi normally clears via renderCall first; this guards result-only invalidates.
 */
function trimShellResults(box: Box): void {
	while (box.children.length > 1) {
		const last = box.children[box.children.length - 1];
		if (!last) break;
		box.removeChild(last);
	}
}

function renderQuietLines(lines: string[], theme: Theme, color: ThemeColor): Text {
	const painted = lines.map((line) => theme.fg(color, line)).join("\n");
	return new Text(painted, 0, 0);
}

function classifyFromResult(
	toolName: string,
	result: AgentToolResult<unknown>,
	isPartial: boolean,
	isError: boolean,
	args: Record<string, unknown>,
): QuietOutcome {
	const details = result.details as EditToolDetails | undefined;
	const content = typeof args.content === "string" ? args.content : "";
	return classifyQuietTool({
		toolName,
		isPartial,
		isError,
		text: resultText(result),
		isImage: resultIsImage(result),
		diff: details?.diff,
		contentLineCount: textLineCount(content),
	});
}

function stockCallContext(
	context: ToolRenderContext<unknown, unknown>,
): ToolRenderContext<unknown, unknown> {
	const state = shellState(context);
	return {
		...context,
		lastComponent: state.stockCall,
	};
}

function stockResultContext(
	context: ToolRenderContext<unknown, unknown>,
): ToolRenderContext<unknown, unknown> {
	const state = shellState(context);
	if (!state.stockResultState) state.stockResultState = {};
	return {
		...context,
		lastComponent: state.stockResult,
		state: state.stockResultState,
	};
}

function resolveOutcome(
	toolName: string,
	index: CompactionIndex,
	toolCallId: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	isError: boolean,
	args: Record<string, unknown>,
): QuietOutcome {
	const settled = index.getRow(toolCallId);
	const canReuseIndex =
		!options.isPartial &&
		settled?.status === "settled" &&
		(settled.outcomeKind === "success" || settled.outcomeKind === "soft");
	if (canReuseIndex) {
		return { kind: settled.outcomeKind!, chip: settled.chip };
	}
	return classifyFromResult(toolName, result, options.isPartial, isError, args);
}

function renderGroupExpanded(
	index: CompactionIndex,
	stockResult: StockToolRenderers["renderResult"],
	theme: Theme,
	context: ToolRenderContext<unknown, unknown>,
): Container {
	const container = new Container();
	const members = index.members(context.toolCallId);

	// Whole-group expand: stacked Stock bodies only (header stays on renderCall).
	for (const member of members) {
		if (!member.result) continue;

		const memberResult = {
			content: member.result.content as AgentToolResult<unknown>["content"],
			details: member.result.details,
		} as AgentToolResult<unknown>;

		if (stockResult) {
			try {
				const memberContext = {
					...context,
					toolCallId: member.toolCallId,
					args: (member.args ?? {}) as Record<string, unknown>,
					isError: Boolean(member.isError),
					isPartial: false,
					expanded: true,
					// Fresh per-member Stock state; do not share the carrier shell state.
					state: {},
					lastComponent: undefined,
				} as ToolRenderContext<unknown, Record<string, unknown>>;
				const body = stockResult(
					memberResult,
					{ expanded: true, isPartial: false },
					theme,
					memberContext,
				);
				container.addChild(body);
			} catch {
				const text = resultText(memberResult);
				if (text) {
					container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				}
			}
		} else {
			const text = resultText(memberResult);
			if (text) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
			}
		}
	}

	return container;
}

function buildQuietRenderers(
	toolName: string,
	isEnabled: () => boolean,
	index: CompactionIndex,
	stock: StockFns,
): Required<Pick<StockToolRenderers, "renderShell">> & StockToolRenderers {
	return {
		renderShell: "self",

		renderCall(args, theme, context) {
			// Invalidate registration only - live onStart/onEnd are driven by
			// tool_execution_* events in index.ts (single writer).
			index.registerInvalidate(context.toolCallId, context.invalidate);

			if (!isEnabled()) {
				if (stock.stockSelfShell) {
					if (stock.renderCall) return stock.renderCall(args, theme, context);
					return new Text(theme.fg("toolTitle", stock.fallbackTitle), 0, 0);
				}
				const box = getShellBox(context);
				resetShell(box, theme, toolShellBgForStock(context.isPartial, context.isError));
				const stockCtx = stockCallContext(context);
				const inner = stock.renderCall
					? stock.renderCall(args, theme, stockCtx)
					: new Text(theme.fg("toolTitle", stock.fallbackTitle), 0, 0);
				shellState(context).stockCall = inner;
				box.addChild(inner);
				return box;
			}

			const role = index.role(context.toolCallId);
			if (role.role === "hidden") {
				return emptyComponent();
			}

			const box = getShellBox(context);
			// Provisional bg; renderResult refines from Quiet outcome when settled.
			resetShell(box, theme, toolShellBgForStock(context.isPartial, context.isError));

			const home = homedir();
			const argsRec = args as Record<string, unknown>;
			if (role.role === "carrier" && role.memberIds.length >= 2) {
				const header = formatGroupHeader(
					groupKindForTool(toolName),
					role.memberIds.length,
				);
				box.addChild(new Text(theme.fg("toolTitle", theme.bold(header)), 0, 0));
				return box;
			}

			// Present tense while running; renderResult rewrites settled lines with chips.
			const line = formatSingletonCallLine(toolName, argsRec, home, {
				running: Boolean(context.isPartial),
			});
			box.addChild(new Text(theme.fg("toolTitle", theme.bold(line)), 0, 0));
			return box;
		},

		renderResult(result, options, theme, context) {
			const args = (context.args ?? {}) as Record<string, unknown>;
			index.registerInvalidate(context.toolCallId, context.invalidate);

			const outcome = resolveOutcome(
				toolName,
				index,
				context.toolCallId,
				result,
				options,
				context.isError,
				args,
			);

			if (!isEnabled()) {
				if (stock.stockSelfShell) {
					if (stock.renderResult) return stock.renderResult(result, options, theme, context);
					return emptyComponent();
				}
				const box = getShellBox(context);
				trimShellResults(box);
				paintShell(box, theme, toolShellBgForStock(options.isPartial, context.isError));
				if (stock.renderResult) {
					const stockCtx = stockResultContext(context);
					const inner = stock.renderResult(result, options, theme, stockCtx);
					shellState(context).stockResult = inner;
					box.addChild(inner);
				}
				return emptyComponent();
			}

			const role = index.role(context.toolCallId);

			if (role.role === "hidden") {
				return emptyComponent();
			}

			const box = getShellBox(context);
			trimShellResults(box);
			const home = homedir();

			if (role.role === "carrier" && role.memberIds.length >= 2) {
				// Groups are settled success/soft only.
				paintShell(box, theme, toolShellBgForQuietOutcome("success"));

				if (options.expanded && outcome.kind !== "pending") {
					const expanded = renderGroupExpanded(index, stock.renderResult, theme, context);
					box.addChild(expanded);
					return emptyComponent();
				}

				const members = index.members(context.toolCallId);
				const pathKeys = members.map((m) => {
					const a = m.args ?? {};
					if (typeof a.path === "string" && a.path) return a.path;
					if (m.toolName === "find" && typeof a.pattern === "string" && a.pattern) {
						return a.pattern;
					}
					return "";
				});
				const targets = displayTargets(pathKeys, home);
				const lines = members.map((m, i) =>
					formatMemberBullet(
						formatMemberSummary(m.toolName, m.args ?? {}, home, {
							displayTarget: pathKeys[i] ? targets[i] : undefined,
						}),
						m.chip,
					),
				);
				// Soft members stay muted only when the whole group is soft-only; else success.
				const allSoft = members.every((m) => m.outcomeKind === "soft");
				const anyHard = members.some((m) => m.outcomeKind === "hard");
				const color: ThemeColor = anyHard ? "error" : allSoft ? "muted" : "success";
				box.addChild(renderQuietLines(lines, theme, color));
				return emptyComponent();
			}

			// Singleton Quiet Row
			paintShell(box, theme, toolShellBgForQuietOutcome(outcome.kind));

			if (options.expanded && outcome.kind !== "pending") {
				// Keep header line in past tense with chip, then Stock body.
				const headerLine = formatSingletonCallLine(toolName, args, home, {
					running: false,
					chip: outcome.chip,
				});
				if (box.children[0]) {
					box.removeChild(box.children[0]);
				}
				box.addChild(new Text(theme.fg("toolTitle", theme.bold(headerLine)), 0, 0));
				if (stock.renderResult) {
					const stockCtx = stockResultContext(context);
					const inner = stock.renderResult(result, options, theme, stockCtx);
					shellState(context).stockResult = inner;
					box.addChild(inner);
				} else {
					const bodyText = resultText(result);
					if (bodyText) {
						box.addChild(new Text(theme.fg("toolOutput", bodyText), 0, 0));
					}
				}
				return emptyComponent();
			}

			// Collapsed: rewrite call line with past-tense verb + parenthetical chip.
			if (outcome.kind === "pending") {
				return emptyComponent();
			}

			const callLine = formatSingletonCallLine(toolName, args, home, {
				running: false,
				chip: outcome.chip,
			});
			if (box.children[0]) {
				box.removeChild(box.children[0]);
			}
			box.addChild(
				new Text(
					theme.fg(
						outcome.kind === "hard" ? "error" : colorForOutcome(outcome.kind),
						theme.bold(callLine),
					),
					0,
					0,
				),
			);

			const showTail = outcome.kind === "hard";
			const tailLines = formatQuietResultLines(outcome, showTail);
			if (tailLines.length > 0) {
				box.addChild(renderQuietLines(tailLines, theme, colorForOutcome(outcome.kind)));
			}
			return emptyComponent();
		},
	};
}

function wrapBuiltin(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	index: CompactionIndex,
	createDef: (cwd: string) => AnyDef,
	toolName: QuietToolName,
): void {
	const schemaDef = createDef(process.cwd());
	// edit already owns Tool Shell Background under renderShell: "self".
	const stockSelfShell = toolName === "edit";

	const quiet = buildQuietRenderers(toolName, isEnabled, index, {
		stockSelfShell,
		fallbackTitle: schemaDef.name,
		renderCall: (args, theme, context) => {
			const def = createDef(context.cwd);
			if (def.renderCall) return def.renderCall(args, theme, context);
			return new Text(theme.fg("toolTitle", schemaDef.name), 0, 0);
		},
		renderResult: (result, options, theme, context) => {
			const def = createDef(context.cwd);
			if (def.renderResult) return def.renderResult(result, options, theme, context);
			return emptyComponent();
		},
	});

	pi.registerTool({
		name: schemaDef.name,
		label: schemaDef.label,
		description: schemaDef.description,
		promptSnippet: schemaDef.promptSnippet,
		promptGuidelines: schemaDef.promptGuidelines,
		parameters: schemaDef.parameters,
		executionMode: schemaDef.executionMode,
		renderShell: quiet.renderShell,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const def = createDef(ctx.cwd);
			return def.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall: quiet.renderCall,
		renderResult: quiet.renderResult,
	});
}

/** Built-in registerTool overrides (no Foreign Tool coverage). */
export function registerQuietTools(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	index: CompactionIndex,
): void {
	wrapBuiltin(pi, isEnabled, index, createReadToolDefinition, "read");
	wrapBuiltin(
		pi,
		isEnabled,
		index,
		createQuietBashToolDefinitionFactory(createBashToolDefinition),
		"bash",
	);
	wrapBuiltin(pi, isEnabled, index, createEditToolDefinition, "edit");
	wrapBuiltin(pi, isEnabled, index, createWriteToolDefinition, "write");
	wrapBuiltin(pi, isEnabled, index, createGrepToolDefinition, "grep");
	wrapBuiltin(pi, isEnabled, index, createFindToolDefinition, "find");
	wrapBuiltin(pi, isEnabled, index, createLsToolDefinition, "ls");
}

/**
 * Register a global Tool Renderer Wrapper when Pi exposes the seam.
 * Returns true when Foreign Tools can participate in Quiet Display.
 */
export function registerQuietToolRendererWrapper(
	pi: ExtensionAPI,
	isEnabled: () => boolean,
	index: CompactionIndex,
): boolean {
	const wrap: ToolRendererWrapper = (toolName, next) => {
		const renderers = next() ?? {};
		const quiet = buildQuietRenderers(toolName, isEnabled, index, {
			stockSelfShell: renderers.renderShell === "self",
			fallbackTitle: toolName,
			renderCall: renderers.renderCall,
			renderResult: renderers.renderResult,
		});
		return {
			renderShell: quiet.renderShell,
			renderCall: quiet.renderCall,
			renderResult: quiet.renderResult,
		};
	};

	const ok = tryRegisterToolRenderer(pi, wrap);
	if (ok) setForeignToolsQuiet(true);
	return ok;
}
