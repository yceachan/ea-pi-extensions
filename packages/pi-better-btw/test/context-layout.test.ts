import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SideChatOverlay } from "../srcs/side-chat-overlay.ts";
import { isFramingMessage } from "../srcs/side-chat-messages.ts";
import { buildExportMarkdown } from "../srcs/side-chat-export.ts";
import { getExtensionDir, loadPromptPack } from "../srcs/prompt-pack.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string): AssistantMessage["content"] => [{ type: "text", text }];
const call = (name: string, args: ToolCall["arguments"]): AssistantMessage["content"] => [{ type: "toolCall", id: "context-call", name, arguments: args }];
function reply(content: AssistantMessage["content"], timestamp = 1): AssistantMessage {
  return { role: "assistant", content: content.map((part) => part.type === "toolCall" ? { ...part, id: `${part.id}-${timestamp}` } : part), api: "openai-responses", provider: "test", model: "context-probe", usage,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp };
}

function setup(script: AssistantMessage["content"][], options: { cwd?: string; fork?: any[] } = {}) {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "btw-context-"));
  writeFileSync(join(cwd, "README.md"), "# Actual file contents\n");
  const requests: any[][] = [];
  const promptPack = loadPromptPack(undefined, { extensionDir: getExtensionDir(), notify(message) { throw new Error(message); } });
  const model: any = { id: "context-probe", api: "openai-responses", provider: "test", reasoning: true, input: ["text"], baseUrl: "https://example.invalid" };
  let step = 0;
  const overlay = new SideChatOverlay({
    tui: { terminal: { columns: 120, rows: 40, write() {} }, requestRender() {} }, theme,
    forkContext: { messages: options.fork ?? [], model, systemPrompt: "Main system prompt, unchanged.", thinkingLevel: "off", cwd, extensionTools: [] },
    tracker: { writeCount: 0 }, sessionManager: { getEntries: () => [], getLeafId: () => null },
    modelRegistry: { streamSimple(_model: any, context: any, options: any) {
      options.signal?.throwIfAborted();
      requests.push(structuredClone(context.messages));
      const content = script[step++];
      if (!content) throw new Error("Unexpected model request");
      const message = reply(content, step);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    } },
    promptPack, readOnlyExtensionAllowlist: [], quiet: true, onToggleQuiet() {},
    onOverlapWarning: async () => true, onBackground() {}, onExport() {}, onClose() {},
  } as any);
  cleanups.push(() => { overlay.dispose(); if (!options.cwd) rmSync(cwd, { recursive: true, force: true }); });
  const agent = (overlay as any).agent;
  return { overlay, agent, requests, cwd, model, promptPack,
    submit: (text: string) => (overlay as any).handleSubmit(text) as Promise<void>,
    framing: () => agent.state.messages.filter(isFramingMessage),
  };
}
const users = (messages: any[]) => messages.filter((message) => message.role === "user")
  .map((message) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text).join("\n"));

// The stub supplies replies, but actual Agent/read/conversion code constructs every request.
test("one persisted initialization precedes the first real question, never a tool continuation or later question", async () => {
  const f = setup([call("read", { path: "README.md", offset: 1, limit: 1 }), answer("# Actual file contents"), answer("second reply")]);
  const initial = f.framing()[0];
  expect(f.framing()).toHaveLength(1);
  for (const part of [f.promptPack.framing, f.promptPack.focusAnchor, f.promptPack.laneReminders.preamble, f.promptPack.laneReminders.failedNote]) {
    const expected = part.replaceAll("{{cwd}}", f.cwd).replaceAll("{{model}}", f.model.id);
    expect(initial.content).toContain(expected);
  }
  const question = "Read README.md and show it in chat.";
  await f.submit(question);
  expect(f.requests).toHaveLength(2);
  for (const request of f.requests) expect(users(request)).toEqual([initial.content, question]);
  expect(f.requests[0]!.at(-1).role).toBe("user");
  expect(f.requests[1]!.at(-1).role).toBe("toolResult");
  expect(f.requests[1]!.at(-1).isError).toBe(false);
  expect(JSON.stringify(f.requests[1]!.at(-1).content)).toContain("# Actual file contents");
  await f.submit("What did you read?");
  expect(users(f.requests[2]!)).toEqual([initial.content, question, "What did you read?"]);
  expect(f.framing()[0]).toBe(initial);
  expect(f.framing()).toHaveLength(1);
  expect(f.agent.state.systemPrompt).toBe("Main system prompt, unchanged.");
  expect(f.agent.state.errorMessage).toBeUndefined();
  const exported = buildExportMarkdown({ messages: f.agent.state.messages, cwd: f.cwd, modelId: f.model.id, toolMode: "read-only", forkedMessageCount: 0, streaming: false });
  expect(exported.split(f.promptPack.focusAnchor)).toHaveLength(2);
  expect(exported.split(f.promptPack.laneReminders.preamble)).toHaveLength(2);
  expect(exported).toContain(question);
});

test("ordinary read failure retains its original error and does not become a lane violation", async () => {
  const f = setup([call("read", { path: "MISSING.md" }), call("read", { path: "README.md" }), answer("# Actual file contents")]);
  const question = "Find and show README.md.";
  await f.submit(question);
  expect(f.requests).toHaveLength(3);
  const results = f.agent.state.messages.filter((message: any) => message.role === "toolResult");
  expect(results.map((message: any) => message.isError)).toEqual([true, false]);
  expect(JSON.stringify(results[0].content)).toContain("ENOENT");
  for (const result of results) {
    expect(JSON.stringify(result.content)).not.toContain(f.promptPack.laneReminders.failedNote);
    expect(JSON.stringify(result.content)).not.toContain("🚧");
  }
  for (const request of f.requests) expect(users(request)).toEqual([f.framing()[0].content, question]);
  expect(f.requests.slice(1).every((request) => request.at(-1).role === "toolResult")).toBe(true);
  expect((f.overlay as any).laneViolations).toBe(0);
  expect(f.agent.state.errorMessage).toBeUndefined();
});

test("initialization is mode-neutral and stays fixed when switching capabilities", async () => {
  const f = setup([answer("edit mode"), answer("read mode")]);
  const initial = f.framing()[0];
  expect(f.agent.state.tools.some((tool: any) => tool.name === "write")).toBe(false);
  f.overlay.handleInput("\x14"); // Ctrl+T
  expect(f.agent.state.tools.some((tool: any) => tool.name === "write")).toBe(true);
  await f.submit("edit-mode question");
  f.overlay.handleInput("\x14");
  expect(f.agent.state.tools.some((tool: any) => tool.name === "write")).toBe(false);
  await f.submit("read-mode question");
  expect(f.framing()).toEqual([initial]);
  expect(users(f.requests[1]!)).toEqual([initial.content, "edit-mode question", "read-mode question"]);
  expect(initial.content).not.toContain("You cannot write files");
});

test("actual unavailable tools stay blocked; the second violation stops the turn without injecting users", async () => {
  const f = setup([call("write", { path: "forbidden.txt", content: "must not be written" }), call("write", { path: "forbidden.txt", content: "still forbidden" }), answer("next turn")]);
  const question = "Try unavailable tools.";
  await f.submit(question);
  expect(existsSync(join(f.cwd, "forbidden.txt"))).toBe(false);
  expect(f.requests).toHaveLength(2);
  expect((f.overlay as any).laneViolations).toBe(2);
  for (const request of f.requests) expect(users(request)).toEqual([f.framing()[0].content, question]);
  expect(JSON.stringify(f.agent.state.messages)).not.toContain("Turn stopped after");
  await f.submit("A new question.");
  expect((f.overlay as any).laneViolations).toBe(0);
  expect(users(f.requests[2]!)).toEqual([f.framing()[0].content, question, "A new question."]);
});

for (const supportsMidConvoSystemMessages of [false, true]) {
  test(`Responses conversion preserves the fork prefix and places initialization at the fork boundary (mid-system=${supportsMidConvoSystemMessages})`, async () => {
    const seed = setup([]);
    const prefix = [
      structuredClone(seed.agent.state.messages[0]),
      { role: "user", content: "Earlier main question.", timestamp: 1 },
      reply(answer("Earlier main answer.")),
    ];
    const f = setup([call("read", { path: "README.md" }), answer("# Actual file contents")], { cwd: seed.cwd, fork: prefix });
    const original = JSON.stringify(prefix);
    await f.submit("Side question.");
    expect(f.requests[0]!.slice(0, prefix.length)).toEqual(prefix);
    expect(JSON.stringify(prefix)).toBe(original);
    const options = { supportsMidConvoSystemMessages };
    const wire = (messages: any[]) => convertResponsesMessages(f.model, normalizeContext({ messages }), new Set(["test"]), options);
    const mainPrefix = wire(prefix);
    const first = wire(f.requests[0]!);
    const continued = wire(f.requests[1]!);
    expect(first.slice(0, mainPrefix.length)).toEqual(mainPrefix);
    expect(continued.slice(0, mainPrefix.length)).toEqual(mainPrefix);
    expect((first[mainPrefix.length] as any).role).toBe("user");
    expect(JSON.stringify(first[mainPrefix.length])).toContain("This initialization marks the start");
    expect((first.at(-1) as any).role).toBe("user");
    expect(JSON.stringify(first.at(-1))).toContain("Side question.");
    expect((continued.at(-1) as any).type).toBe("function_call_output");
  });
}
