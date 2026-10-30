import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { SideChatMessages } from "../srcs/side-chat-messages.ts";
import { SideChatOverlay } from "../srcs/side-chat-overlay.ts";
import { isLeftPress, isLeftDrag, isLeftRelease, isWheelEvent, wheelDirection, parseSgrMouseEvent } from "../srcs/side-chat-mouse.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");
let copiedTexts: string[] = [];
const takeCopies = () => { const result = copiedTexts; copiedTexts = []; return result; };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const WIDTH = 108; // 90% of a 120-column terminal.
const DEFAULT_MESSAGES: any[] = [
  { role: "user", content: "hello world this is a long message" },
  { role: "assistant", content: [{ type: "text", text: "assistant reply with some content" }] },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "tool output line" }] },
];

function makeOverlay(): SideChatOverlay {
  const overlay = new SideChatOverlay({
    tui: { terminal: { columns: 120, rows: 40, write() {} }, requestRender() {} }, theme,
    forkContext: { messages: [], model: { id: "test-model" }, systemPrompt: "", thinkingLevel: "off", cwd: "/tmp", extensionTools: [] },
    tracker: { writeCount: 0 }, modelRegistry: {}, sessionManager: { getEntries: () => [], getLeafId: () => null },
    promptPack: { framing: "", focusAnchor: "", laneReminders: { preamble: "", base: "", escalated: "", failedNote: "" } },
    readOnlyExtensionAllowlist: [], onOverlapWarning: async () => true, onBackground() {}, onExport() {}, onClose() {},
    copyText: async (text: string) => { copiedTexts.push(text); },
  } as any);
  (overlay as any).messages.setMessages(DEFAULT_MESSAGES);
  overlay.render(WIDTH);
  return overlay;
}

// Use the rendered origin: header padding, preset changes and resizing must
// not make the selection tests accidentally click on the title or input box.
function mouse(overlay: SideChatOverlay, button: number, col: number, line = 1, release = false) {
  const g = (overlay as any).geometry;
  overlay.handleMouseEvent({ button, col: g.contentCol + col + 1, row: g.msgTopRow + line + 1, isRelease: release });
}
function drag(overlay: SideChatOverlay) {
  mouse(overlay, 0, 2); mouse(overlay, 32, 7); mouse(overlay, 0, 7, 1, true);
}
const messagesOf = (overlay: SideChatOverlay): SideChatMessages => (overlay as any).messages;

describe("side-chat-mouse.ts", () => {
  test("classifies SGR wheel, press, drag and both release forms", () => {
    const event = (text: string) => parseSgrMouseEvent(text)!;
    const up = event("\x1b[<64;10;5M"), down = event("\x1b[<65;10;5M");
    const press = event("\x1b[<0;10;5M"), motion = event("\x1b[<32;10;5M");
    expect(isWheelEvent(up) && wheelDirection(up) === 1).toBe(true);
    expect(isWheelEvent(down) && wheelDirection(down) === -1).toBe(true);
    expect(isWheelEvent(event("\x1b[<67;10;5m"))).toBe(false);
    expect(isLeftPress(press)).toBe(true);
    expect(isLeftDrag(motion)).toBe(true);
    expect(isLeftRelease(event("\x1b[<0;10;5m"))).toBe(true);
    expect(isLeftRelease(event("\x1b[<3;10;5m"))).toBe(true);
    const right = event("\x1b[<2;10;5M");
    expect(isLeftPress(right) || isLeftDrag(right)).toBe(false);
    expect(isLeftDrag(press) || isLeftPress(motion)).toBe(false);
  });
});

describe("side-chat-messages.ts", () => {
  test("renders lines and strips ANSI", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    expect(stripTerminalSequences(messages.render(80)[1]!).startsWith("│ hello world")).toBe(true);
  });
  test("highlights selection and extracts exact text without background padding", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES); messages.render(80);
    messages.setSelection({ line: 1, col: 2 }, { line: 1, col: 7 });
    const line = messages.render(80)[1]!;
    expect(line).toContain("\x1b[7m"); expect(line).toContain("\x1b[27m");
    expect(messages.getSelectedText()).toBe("hello"); expect(messages.hasSelection()).toBe(true);
    messages.clearSelection(); expect(messages.hasSelection()).toBe(false);
    expect(messages.render(80)[1]).not.toContain("\x1b[7m");
  });
  test("cross-line selection joins rendered lines", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES); messages.render(80);
    messages.setSelection({ line: 1, col: 2 }, { line: 4, col: 8 });
    expect(messages.getSelectedText()).toBe("hello world this is a long message\n\n\nassistan");
  });
  test("maps CJK wide characters cell to character consistently", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages([{ role: "user", content: "你好世界hello", timestamp: 1 }]); messages.render(80);
    messages.setSelection({ line: 1, col: 2 }, { line: 1, col: 8 });
    expect(messages.getSelectedText()).toBe("你好世");
  });
  test("scroll clears selection", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES); messages.render(80);
    messages.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 }); messages.scrollBy(1);
    expect(messages.hasSelection()).toBe(false);
  });
  test("appended status lines keep selection anchored", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES); messages.render(80);
    messages.setSelection({ line: 4, col: 0 }, { line: 4, col: 80 });
    const before = messages.getSelectedText(); expect(before.startsWith("assistant reply")).toBe(true);
    messages.setToolStatus("✓ Copied 10 chars");
    const rendered = messages.render(80);
    expect(messages.getSelectedText()).toBe(before);
    const highlighted = rendered.find((line) => line.includes("\x1b[7m"));
    expect(stripTerminalSequences(highlighted!).startsWith("assistant reply")).toBe(true);
    messages.clearToolStatusIf("✓ Copied 10 chars"); messages.render(80);
    expect(messages.getSelectedText()).toBe(before);
  });
});

describe("side-chat-overlay.ts", () => {
  test("floating geometry matches centered 90%-width / 92%-height placement", () => {
    const overlay = makeOverlay(), g = (overlay as any).geometry;
    const frame = overlay.render(WIDTH);
    expect(frame).toHaveLength(36);
    expect(g.msgTopRow).toBe(6); // centered row 2 + four-row single-line header
    expect(g.contentCol).toBe(8); // centered col 6 + padding 2
    expect(g.innerWidth).toBe(104);
    expect(g.msgHeight).toBe(27);
  });
  test("wheel over the chat scrolls", () => {
    const overlay = makeOverlay(), messages = messagesOf(overlay);
    const before = messages.getScrollOffset(); mouse(overlay, 64, 8);
    expect(messages.getScrollOffset()).toBeGreaterThanOrEqual(before);
  });
  test("drag-select keeps selection on release without auto-copy", async () => {
    const overlay = makeOverlay(); mouse(overlay, 0, 2); mouse(overlay, 32, 7);
    expect(overlay.isMouseDragging()).toBe(true); mouse(overlay, 0, 7, 1, true); await tick();
    expect(takeCopies()).toHaveLength(0); expect(messagesOf(overlay).hasSelection()).toBe(true);
    expect(messagesOf(overlay).getSelectedText()).toBe("hello");
  });
  test("Ctrl+C and Ctrl+Shift+C copy retained selection; no selection falls through", async () => {
    const overlay = makeOverlay(); drag(overlay); await tick(); expect(takeCopies()).toHaveLength(0);
    overlay.handleInput("\x03"); await tick(); expect(takeCopies()).toEqual(["hello"]);
    overlay.handleInput("\x1b[99;6u"); await tick(); expect(takeCopies()).toHaveLength(1);
    messagesOf(overlay).clearSelection(); overlay.handleInput("\x03"); await tick(); expect(takeCopies()).toHaveLength(0);
  });
  test("copy feedback shows in status", async () => {
    copiedTexts = []; const overlay = makeOverlay(); drag(overlay); overlay.handleInput("\x03"); await tick();
    expect(messagesOf(overlay).render(80).some((line) => line.includes("Copied"))).toBe(true); takeCopies();
  });
  test("plain click clears selection without copying", () => {
    const overlay = makeOverlay(), messages = messagesOf(overlay);
    messages.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    mouse(overlay, 0, 1); mouse(overlay, 0, 1, 1, true);
    expect(takeCopies()).toHaveLength(0); expect(overlay.isMouseDragging()).toBe(false); expect(messages.hasSelection()).toBe(false);
  });
  test("quick click after a drag is not mistaken for a double-click", async () => {
    const overlay = makeOverlay(); drag(overlay); await tick(); expect(messagesOf(overlay).hasSelection()).toBe(true);
    mouse(overlay, 0, 6); mouse(overlay, 0, 6, 1, true); await tick();
    expect(messagesOf(overlay).hasSelection()).toBe(false); expect(takeCopies()).toHaveLength(0);
  });
  test("double-click selects whole line; copy is hotkey-only", async () => {
    const overlay = makeOverlay();
    for (let i = 0; i < 2; i++) { mouse(overlay, 0, 6); mouse(overlay, 0, 6, 1, true); }
    await tick(); expect(messagesOf(overlay).getSelectedText().trimStart().startsWith("hello world")).toBe(true);
    expect(takeCopies()).toHaveLength(0); overlay.handleInput("\x03"); await tick();
    const copied = takeCopies(); expect(copied).toHaveLength(1); expect(copied[0]!.trimStart().startsWith("hello world")).toBe(true);
  });
  test("drag beyond viewport clamps to last content line", () => {
    const overlay = makeOverlay(); mouse(overlay, 0, 2); mouse(overlay, 32, 2, 40);
    expect(messagesOf(overlay).getSelectedText()).toContain("tool output"); mouse(overlay, 0, 2, 40, true);
    expect(messagesOf(overlay).hasSelection()).toBe(true); expect(takeCopies()).toHaveLength(0);
  });
  test("click on header is not captured as a drag", () => {
    const overlay = makeOverlay(); mouse(overlay, 0, 4, -2); expect(overlay.isMouseDragging()).toBe(false);
  });
  test("anchor survives mid-drag status append in overflowing history", async () => {
    const overlay = makeOverlay(), messages = messagesOf(overlay);
    messages.setMessages(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `message number ${i}`, timestamp: i })));
    overlay.render(WIDTH);
    const visible = messages.render(WIDTH - 4).map(stripTerminalSequences);
    // Leave room for the two appended status rows: selections that actually
    // scroll out of the viewport are intentionally dropped.
    const row = visible.findIndex((line, i) => i >= 2 && line.includes("message number"));
    const expected = visible[row]!.replace(/^│/, "").trim();
    mouse(overlay, 0, 2, row); mouse(overlay, 32, 30, row);
    messages.setToolStatus("✓ Copied 5 chars"); overlay.render(WIDTH); mouse(overlay, 0, 30, row, true);
    expect(messages.getSelectedText()).toContain(expected);
    overlay.handleInput("\x03"); await tick(); const copied = takeCopies();
    expect(copied).toHaveLength(1); expect(copied[0]).toContain(expected);
  });
  test("cancelMouseDrag aborts an in-flight drag", () => {
    const overlay = makeOverlay(); mouse(overlay, 0, 7); expect(overlay.isMouseDragging()).toBe(true);
    overlay.cancelMouseDrag(); expect(overlay.isMouseDragging()).toBe(false);
    mouse(overlay, 0, 7, 0, true); expect(overlay.isMouseDragging()).toBe(false);
  });
  test("copy failure surfaces an error status", async () => {
    const overlay = makeOverlay(), messages = messagesOf(overlay);
    messages.setSelection({ line: 1, col: 2 }, { line: 1, col: 5 });
    (overlay as any).options.copyText = async () => { throw new Error("clipboard unavailable"); };
    expect(await overlay.copySelectionToClipboard()).toBe(false);
    expect(messages.render(80).some((line) => line.includes("Copy failed"))).toBe(true);
  });
});
