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
  expect(folded).toContain("[read]: call");
  expect(folded).toContain("[read]: done");
  expect(folded).not.toContain("private thought");
  expect(folded).not.toContain("/secret/path");
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
  expect(text(side)).not.toContain("/secret/path");
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

test("folded tool summaries remain single-line and within narrow terminal widths", () => {
  const side = new SideChatMessages(theme, 200);
  const call = assistant();
  call.content = call.content.filter((part) => part.type === "toolCall");
  side.setMessages([call, result()]);
  for (const width of [1, 4, 20, 80]) {
    const lines = side.render(width);
    expect(lines.filter((line) => stripTerminalSequences(line).trim())).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
});
