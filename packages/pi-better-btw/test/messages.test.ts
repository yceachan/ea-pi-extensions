import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SideChatMessages } from "../srcs/side-chat-messages.ts";
import { PanelPalette } from "../srcs/side-chat-panel.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");

const markdown = "# Results\n\n**Strong** and *emphasis*, `inline` code.\n\n- First item\n- 第二项\n\n```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Count | 42 |";
function reply(text = markdown): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "thinking", thinking: "Let me reason about this." }, { type: "text", text }],
    api: "openai-completions", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0,
  };
}
function trimBlankLines(lines: string[]): string[] {
  const result = lines.map((line) => stripTerminalSequences(line).trimEnd());
  while (result.length && !result[0]!.trim()) result.shift();
  while (result.length && !result[result.length - 1]!.trim()) result.pop();
  return result;
}

describe("Pi-style message navigation", () => {
  test("jumps to user and final AI starts, not context/tool rows; freezes while output grows", () => {
    const side = new SideChatMessages(theme, 200);
    const toolCall = reply("checking a file");
    toolCall.content.push({ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } });
    const history: any[] = [
      { role: "user", content: "injected context", timestamp: 0 },
      { role: "user", content: "first\na\nb\nc\nd", timestamp: 1 },
      toolCall,
      { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "tool result" }], isError: false, timestamp: 2 },
      reply("answer\n\na\n\nb\n\nc"),
      { role: "user", content: "second\na\nb\nc\nd", timestamp: 3 },
      reply("last\n\na\n\nb\n\nc\n\nd"),
    ];
    side.setInjectedMessageCount(1);
    side.setMessages(history);
    side.render(60);
    const starts = [...(side as any).promptStarts] as number[];
    expect(starts).toHaveLength(4);
    side.setMaxVisibleLines(4);
    side.render(60);
    side.scrollBy(10000);
    side.render(60);
    side.jumpToMessage(1); side.render(60);
    expect((side as any).lastRenderStart).toBe(starts[0]);
    side.jumpToMessage(1); side.render(60);
    expect((side as any).lastRenderStart).toBe(starts[1]);
    side.setToolStatus("streaming tool status\nanother line");
    side.render(60);
    expect((side as any).lastRenderStart).toBe(starts[1]);
    side.jumpToMessage(-1); side.render(60);
    expect((side as any).lastRenderStart).toBe(starts[0]);
    side.jumpToMessage(1); side.render(60);
    side.jumpToMessage(1); side.render(60);
    expect((side as any).lastRenderStart).toBe(starts[2]);
  });

  test("includes the current streaming AI response as a jump target", () => {
    const side = new SideChatMessages(theme, 3);
    side.setMessages([{ role: "user", content: "prompt\na\nb\nc\nd", timestamp: 0 }]);
    side.setStreamingMessage(reply("streaming\n\na\n\nb\n\nc"));
    side.render(40);
    side.scrollBy(10000); side.render(40);
    side.jumpToMessage(1); side.render(40);
    expect((side as any).promptStarts).toHaveLength(2);
    expect((side as any).lastRenderStart).toBe((side as any).promptStarts[1]);
  });
});

describe("Pi assistant-message formatting", () => {
  test("completed Markdown, code, tables and thinking use the main conversation renderer", () => {
    const message = reply();
    const side = new SideChatMessages(theme, 200);
    side.setQuiet(false);
    side.setMessages([message]);
    const main = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), undefined, 0);
    main.updateContent(message);
    expect(trimBlankLines(side.render(72))).toEqual(trimBlankLines(main.render(72)));
    const text = side.render(72).map(stripTerminalSequences).join("\n");
    expect(text).toContain("Let me reason about this.");
    expect(text).toContain("const answer = 42;");
    expect(text).not.toContain("**Strong**");
    expect(text).not.toContain("[Assistant]:");
    expect(side.render(72).join("\n")).not.toContain("\x1b]133;");
    for (const width of [16, 30, 72]) {
      expect(side.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  test("streaming uses the same formatting as completion, then clears without duplication", () => {
    const message = reply();
    const side = new SideChatMessages(theme, 200);
    side.setStreamingMessage(message);
    const streamed = trimBlankLines(side.render(72));
    side.setMessages([message]);
    side.setStreamingContent("");
    expect(trimBlankLines(side.render(72))).toEqual(streamed);
    expect(side.render(72).map(stripTerminalSequences).join("\n").match(/const answer = 42;/g)).toHaveLength(1);
    side.setStreamingMessage(reply("next response"));
    side.setErrorContent("Oops");
    expect(side.render(72).map(stripTerminalSequences).join("\n")).not.toContain("next response");
  });

  test("padded native user cards and unboxed AI follow the theme even when selected or streaming", () => {
    try {
      for (const appearance of ["dark", "light"]) {
        initTheme(appearance);
        const palette = new PanelPalette();
        const side = new SideChatMessages(theme, 200, palette);
        const message = reply("**hello** `world`");
        message.content = message.content.filter((part) => part.type !== "thinking");
        side.setMessages([{ role: "user", content: "question", timestamp: 0 }, message]);
        const lines = side.render(60);
        const colors = palette.get(theme);
        const userBg = backgroundAnsi(colors.user, theme.getColorMode());
        const bodyBg = backgroundAnsi(colors.body, theme.getColorMode());
        expect(userBg).not.toBe(bodyBg);
        for (const index of [0, 1, 2]) expect(lines[index]).toStartWith(userBg);
        expect(stripTerminalSequences(lines[0]!).trim()).toBe("│");
        expect(stripTerminalSequences(lines[1]!)).toStartWith("│ question");
        expect(stripTerminalSequences(lines[2]!).trim()).toBe("│");
        expect(lines[4]).toStartWith(bodyBg);
        expect(lines.map(stripTerminalSequences).join("\n")).not.toContain("[You]");
        side.setSelection({ line: 1, col: 2 }, { line: 1, col: 60 });
        expect(side.render(60)[1]).toStartWith(userBg);
        expect(side.getSelectedText()).toBe("question");
        side.setMessages([]); side.setStreamingMessage(message);
        const streamed = side.render(60);
        expect(streamed[0]).toStartWith(bodyBg);
        expect(streamed.every((line) => visibleWidth(line) === 60)).toBe(true);
      }
    } finally { initTheme("dark"); }
  });

  test("user rails preserve wrapping, text coordinates and clean copying at narrow widths", () => {
    const side = new SideChatMessages(theme, 200);
    side.setMessages([{ role: "user", content: "你好world\nsecond line", timestamp: 0 }]);
    for (const width of [1, 2, 3, 4, 5, 6, 12, 60]) {
      side.clearSelection();
      const lines = side.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const plain = lines.map(stripTerminalSequences);
      if (width >= 5) {
        expect(plain.slice(0, -1).every((line) => line.startsWith("│"))).toBe(true);
        expect(plain[plain.length - 1]!.trim()).toBe("");
      } else {
        expect(plain.join("\n")).not.toContain("│");
      }
    }
    side.render(60);
    side.setSelection({ line: 0, col: 0 }, { line: 3, col: 60 });
    const selected = side.getSelectedText();
    expect(selected).toContain("你好world");
    expect(selected).toContain("second line");
    expect(selected).not.toContain("│");
    expect(selected).not.toContain("\x1b");
    expect(side.render(60).slice(0, 4).every((line) => stripTerminalSequences(line).startsWith("│"))).toBe(true);
    side.setMessages([reply("plain AI answer")]);
    side.clearSelection();
    expect(side.render(60).map(stripTerminalSequences).join("\n")).not.toContain("│");
  });

  test("selection copies rendered Markdown rather than source delimiters or ANSI", () => {
    const side = new SideChatMessages(theme, 30);
    const message = reply("**hello** `world`");
    message.content = message.content.filter((part) => part.type !== "thinking");
    side.setMessages([message]);
    side.render(60);
    side.setSelection({ line: 0, col: 0 }, { line: 0, col: 60 });
    expect(side.getSelectedText()).toBe("hello world");
  });
});
