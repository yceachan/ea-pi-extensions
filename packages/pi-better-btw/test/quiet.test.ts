import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SideChatMessages } from "../srcs/side-chat-messages.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");
function assistant(): AssistantMessage {
  return {
    role: "assistant", content: [
      { type: "thinking", thinking: "private thought" },
      { type: "text", text: "**Visible answer**" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "/secret/path" } },
    ],
    api: "openai-completions", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: 0,
  };
}
const result = (isError = false): AgentMessage => ({
  role: "toolResult", toolCallId: "call", toolName: "read", isError, timestamp: 1,
  content: [{ type: "text", text: "RESULT_BODY " + "output ".repeat(50) }, { type: "text", text: "RESULT_TAIL" }],
});
const text = (side: SideChatMessages, width = 80) => side.render(width).map(stripTerminalSequences).join("\n");

test("quiet defaults on; toggling rerenders cached history without changing messages", () => {
  const side = new SideChatMessages(theme, 200);
  const history = [assistant(), result()];
  const original = JSON.stringify(history);
  side.setMessages(history);
  const folded = text(side);
  expect(folded).toContain("Thinking...");
  expect(folded).toContain("Visible answer");
  expect(folded).toContain("read /secret/path");
  expect(folded).not.toContain("done");
  expect(folded).not.toContain("call");
  expect(folded).not.toContain("private thought");
  expect(folded).not.toContain("RESULT_BODY");
  side.setSelection({ line: 0, col: 0 }, { line: 5, col: 80 });
  expect(side.getSelectedText()).not.toContain("private thought");
  side.setQuiet(false);
  expect(side.hasSelection()).toBe(false);
  const expanded = text(side);
  expect(expanded).toContain("private thought");
  expect(expanded).toContain("/secret/path");
  expect(expanded).toContain("RESULT_BODY");
  expect(expanded).toContain("RESULT_TAIL");
  expect(expanded).toContain("Visible answer");
  side.setQuiet(true);
  expect(text(side)).toBe(folded);
  expect(JSON.stringify(history)).toBe(original);
});

test("streaming thinking and tool arguments switch immediately and retain completion formatting", () => {
  const side = new SideChatMessages(theme, 200);
  const message = assistant();
  side.setStreamingMessage(message);
  expect(text(side)).not.toContain("private thought");
  expect(text(side)).toContain("read /secret/path");
  expect(text(side)).toContain("Visible answer");
  side.setQuiet(false);
  const expanded = text(side);
  expect(expanded).toContain("private thought");
  expect(expanded).toContain("/secret/path");
  side.setMessages([message]);
  side.setStreamingContent("");
  expect(text(side).trimEnd()).toBe(expanded.trimEnd());
  side.setQuiet(true);
  expect(text(side)).not.toContain("private thought");
});

test("failed tools retain a compact error status and expand their full result on demand", () => {
  const side = new SideChatMessages(theme, 200);
  side.setMessages([result(true)]);
  expect(text(side)).toContain("[read]: failed");
  expect(text(side)).not.toContain("RESULT_BODY");
  side.setQuiet(false);
  expect(text(side)).toContain("RESULT_BODY");
  expect(text(side)).toContain("RESULT_TAIL");
  side.setQuiet(true);
  side.setErrorContent("provider error");
  expect(text(side)).toContain("provider error");
});

test("folded tools show a single useful call line, with paths/commands and no success row", () => {
  const side = new SideChatMessages(theme, 200);
  for (const [name, args, expected] of [
    ["read", { path: "src/index.ts", offset: 20 }, "read src/index.ts"],
    ["edit", { path: "src/config.ts", edits: [{ oldText: "before", newText: "after" }] }, "edit src/config.ts"],
    ["bash", { command: "bun run test\nSECOND_COMMAND", timeout: 30 }, "bash bun run test"],
    ["search", { query: "useful query" }, 'search {"query":"useful query"}'],
    ["grep", { pattern: "needle", path: "src" }, 'grep {"pattern":"needle","path":"src"}'],
  ] as const) {
    const call = assistant();
    call.content = [{ type: "toolCall", id: "call", name, arguments: args }];
    side.setMessages([call, result()]);
    expect(text(side).trim()).toBe(expected);
    for (const width of [1, 4, 20, 80]) {
      const lines = side.render(width);
      expect(lines.filter((line) => stripTerminalSequences(line).trim())).toHaveLength(1);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    side.setStreamingMessage(call);
    side.setMessages([]);
    expect(text(side).trim()).toBe(expected);
    expect(text(side)).not.toContain("SECOND_COMMAND");
    side.setStreamingContent("");
  }
});
