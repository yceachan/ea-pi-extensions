import { describe, expect, test } from "bun:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	Theme,
	ToolRendererResolver,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { CompactionIndex } from "../src/compaction.ts";
import type { ToolRenderContext } from "../src/tool-renderer-api.ts";
import { registerQuietToolRendererWrapper } from "../src/tools.ts";

// Exercise the host's actual resolver signature and TUI components without a
// Pi process, a terminal, or a model. Only the extension-registration API is stubbed.
const theme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function context(args: Record<string, unknown> = {}, id = "call-1"): ToolRenderContext {
	return {
		args, toolCallId: id, state: {}, invalidate() {},
		lastComponent: undefined, cwd: "/workspace", executionStarted: true,
		argsComplete: true, isPartial: true, expanded: false, showImages: false,
		isError: false, durationMs: undefined, outputPad: 1,
	};
}

function output(component: Component): string {
	return component.render(160).map((line) => line.trimEnd()).join("\n").trim();
}

function result(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function setup() {
	let enabled = true;
	let resolver: ToolRendererResolver | undefined;
	let replacements = 0;
	const api = {
		registerToolRenderer(value: ToolRendererResolver) { resolver = value; },
		registerTool() { replacements++; },
	} as unknown as ExtensionAPI;
	const index = new CompactionIndex();
	expect(registerQuietToolRendererWrapper(api, () => enabled, index)).toBe(true);
	expect(replacements).toBe(0);
	return {
		index,
		toggle(value: boolean) { enabled = value; },
		resolve(name: string, next: () => ToolRenderers | undefined = () => undefined) {
			return resolver!(name, next)!;
		},
	};
}

// Pi composes the call and result components, sharing renderer state between them.
function draw(renderers: ToolRenderers, ctx: ToolRenderContext, text?: string): string {
	const call = renderers.renderCall!(ctx.args, theme, ctx);
	const body = text === undefined ? undefined : renderers.renderResult!(
		result(text), { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme, ctx,
	);
	return [output(call), body && output(body)].filter(Boolean).join("\n");
}

describe("Pi 1.1 tool renderer resolver", () => {
	for (const [name, args, pending, settled] of [
		["read", { path: "/tmp/example.txt" }, "📖 Reading example.txt", "📖 Read example.txt (2 lines)"],
		["bash", { command: "pwd" }, "💻 $ pwd", "💻 $ pwd"],
		["codemode", { code: "text(42)" }, "🧩 Calling codemode text(42)", "🧩 Called codemode text(42)"],
		["mcp__server__lookup", { query: "hello" }, "🧩 Calling mcp__server__lookup hello", "🧩 Called mcp__server__lookup hello"],
	] as const) {
		test(`${name}: correct name while running and after completion`, () => {
			const h = setup();
			let nextCalls = 0;
			const renderers = h.resolve(name, () => { nextCalls++; return {}; });
			expect(nextCalls).toBe(1);
			const ctx = context(args);
			expect(draw(renderers, ctx)).toBe(pending);
			ctx.isPartial = false;
			expect(draw(renderers, ctx, "one\ntwo")).toBe(settled);
		});
	}

	test("quiet off preserves downstream renderers, arguments, and reusable components", () => {
		const h = setup();
		h.toggle(false);
		const args = { command: "pwd" };
		const ctx = context(args);
		ctx.isPartial = false;
		let previousCall: Component | undefined;
		let previousResult: Component | undefined;
		const renderers = h.resolve("bash", () => ({
			renderCall(received, _theme, stockCtx) {
				expect(received).toBe(args);
				expect(stockCtx.toolCallId).toBe(ctx.toolCallId);
				expect(stockCtx.lastComponent).toBe(previousCall);
				return previousCall = new Text("original bash call", 0, 0);
			},
			renderResult(received, options, _theme, stockCtx) {
				expect(received.content).toEqual(result("stdout").content);
				expect(options.isPartial).toBe(false);
				expect(stockCtx.args).toBe(args);
				expect(stockCtx.state).not.toBe(ctx.state);
				expect(stockCtx.lastComponent).toBe(previousResult);
				return previousResult = new Text("original bash result", 0, 0);
			},
		}));
		for (let i = 0; i < 2; i++) {
			expect(draw(renderers, ctx, "stdout")).toBe("original bash call\noriginal bash result");
		}
	});

	test("quiet off preserves self-owned framing and state", () => {
		const h = setup();
		h.toggle(false);
		const ctx = context({ path: "file.ts" });
		const originalCall = new Text("edit header", 0, 0);
		const originalResult = new Text("edit diff", 0, 0);
		const renderers = h.resolve("edit", () => ({
			renderShell: "self",
			renderCall(_args, _theme, received) { expect(received).toBe(ctx); return originalCall; },
			renderResult(_result, _options, _theme, received) { expect(received).toBe(ctx); return originalResult; },
		}));
		expect(renderers.renderShell).toBe("self");
		expect(renderers.renderCall!(ctx.args, theme, ctx)).toBe(originalCall);
		expect(renderers.renderResult!(result("diff"), { expanded: true, isPartial: false }, theme, ctx)).toBe(originalResult);
	});

	test("expanded codemode uses the downstream result renderer; off restores its call", () => {
		const h = setup();
		const ctx = context({ code: "text(42)" });
		ctx.isPartial = false;
		ctx.expanded = true;
		const renderers = h.resolve("codemode", () => ({
			renderCall: () => new Text("original script", 0, 0),
			renderResult(_result, options) {
				expect(options.expanded).toBe(true);
				return new Text("original structured output", 0, 0);
			},
		}));
		expect(draw(renderers, ctx, "42")).toBe("🧩 Called codemode text(42)\noriginal structured output");
		h.toggle(false);
		expect(draw(renderers, ctx, "42")).toBe("original script\noriginal structured output");
	});

	test("missing downstream renderer keeps an unknown tool's name and expanded text", () => {
		const h = setup();
		const ctx = context({ query: "hello" });
		const renderers = h.resolve("disconnected_tool");
		expect(draw(renderers, ctx)).toBe("🧩 Calling disconnected_tool hello");
		ctx.isPartial = false;
		ctx.expanded = true;
		expect(draw(renderers, ctx, "answer")).toBe("🧩 Called disconnected_tool hello\nanswer");
		h.toggle(false);
		expect(draw(renderers, ctx)).toBe("disconnected_tool");
	});

	test("read grouping retains the file kind and expands each member with original args", () => {
		const h = setup();
		for (const [id, path, text] of [["a", "/tmp/a.ts", "body a"], ["b", "/tmp/b.ts", "body b"]]) {
			h.index.onStart({ toolCallId: id, toolName: "read", args: { path } });
			h.index.onEnd({ toolCallId: id, toolName: "read", outcomeKind: "success", chip: "1 line", result: result(text) });
		}
		const renderers = h.resolve("read", () => ({
			renderResult(received, options, _theme, memberCtx) {
				expect(options.expanded).toBe(true);
				return new Text(`${(memberCtx.args as { path: string }).path}: ${(received.content[0] as { text: string }).text}`, 0, 0);
			},
		}));
		const hiddenCtx = context({ path: "/tmp/a.ts" }, "a");
		hiddenCtx.isPartial = false;
		expect(draw(renderers, hiddenCtx, "body a")).toBe("");
		const ctx = context({ path: "/tmp/b.ts" }, "b");
		ctx.isPartial = false;
		expect(draw(renderers, ctx, "body b")).toBe("📖 Read 2 files\n  • a.ts (1 line)\n  • b.ts (1 line)");
		ctx.expanded = true;
		expect(draw(renderers, ctx, "body b")).toBe("📖 Read 2 files\n/tmp/a.ts: body a\n/tmp/b.ts: body b");
	});

	test("hosts without the hook return false without replacing tools", () => {
		expect(registerQuietToolRendererWrapper({} as ExtensionAPI, () => true, new CompactionIndex())).toBe(false);
	});
});
