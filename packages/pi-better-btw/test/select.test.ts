/**
 * Regression tests for the side chat mouse selection (issue #17, C scheme):
 * drag/double-click select with an inverse-video highlight; copying is
 * hotkey-only via Ctrl+C / Ctrl+Shift+C on the retained selection. Runs
 * against the real modules with a mocked TUI/theme; the real copyToClipboard
 * cascade lands on its OSC 52 fallback in CI-like environments (no
 * wl-copy/xclip), which is captured via stdout.
 */
import { describe, expect, test } from "bun:test";
import { SideChatMessages } from "../srcs/side-chat-messages.ts";
import { SideChatOverlay } from "../srcs/side-chat-overlay.ts";
import {
  isLeftPress,
  isLeftDrag,
  isLeftRelease,
  isWheelEvent,
  wheelDirection,
  parseSgrMouseEvent,
} from "../srcs/side-chat-mouse.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// Capture the real copyToClipboard cascade at its OSC 52 fallback.
let osc52Writes: string[] = [];
(process.stdout as any).write = (s: string) => {
  const match = /\x1b]52;c;([^\x07]+)\x07/.exec(s);
  if (match) osc52Writes.push(Buffer.from(match[1], "base64").toString("utf8"));
  return true;
};
const osc52CopiedText = (): string[] => {
  const out = [...osc52Writes];
  osc52Writes = [];
  return out;
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const theme: any = { fg: (_name: string, text: string) => text };
// Width the overlay would compute for 120 columns (floor(120*0.85) = 102; see
// computeChatGeometry). The hint bar is a fixed two rows regardless of width,
// so the message-area height is stable; render with the real width for
// fidelity to the runtime layout that the hardcoded coordinates assume.
const WIDTH = 102;
const DEFAULT_MESSAGES: any[] = [
  { role: "user", content: "hello world this is a long message" },
  {
    role: "assistant",
    content: [{ type: "text", text: "assistant reply with some content" }],
  },
  {
    role: "toolResult",
    toolName: "bash",
    content: [{ type: "text", text: "tool output line" }],
  },
];

function makeOverlay(): SideChatOverlay {
  const opts: any = {
    tui: {
      terminal: { columns: 120, rows: 40, write: () => {} },
      requestRender: () => {},
    },
    theme,
    forkContext: {
      messages: [],
      model: { id: "test-model" },
      systemPrompt: "",
      thinkingLevel: "off",
      cwd: "/tmp",
      extensionTools: [],
    },
    tracker: { writeCount: 0 },
    modelRegistry: {},
    sessionManager: { getEntries: () => [], getLeafId: () => null },
    promptPack: {
      framing: "",
      focusAnchor: "",
      laneReminders: { preamble: "", base: "", escalated: "", failedNote: "" },
    },
    readOnlyExtensionAllowlist: [],
    onOverlapWarning: async () => true,
    onBackground: () => {},
    onExport: () => {},
    onClose: () => {},
  };
  const overlay = new SideChatOverlay(opts);
  (overlay as any).messages.setMessages(DEFAULT_MESSAGES);
  overlay.render(WIDTH); // innerWidth 98 → two hint rows, chat height as hardcoded
  return overlay;
}

describe("side-chat-mouse.ts", () => {
  test("classifies SGR events", () => {
    const wheelUp = parseSgrMouseEvent("\x1b[<64;10;5M")!;
    const wheelDown = parseSgrMouseEvent("\x1b[<65;10;5M")!;
    const wheelRelease = parseSgrMouseEvent("\x1b[<67;10;5m")!;
    const leftPress = parseSgrMouseEvent("\x1b[<0;10;5M")!;
    const leftDrag = parseSgrMouseEvent("\x1b[<32;10;5M")!;
    const leftRelease0 = parseSgrMouseEvent("\x1b[<0;10;5m")!;
    const leftRelease3 = parseSgrMouseEvent("\x1b[<3;10;5m")!;
    const rightPress = parseSgrMouseEvent("\x1b[<2;10;5M")!;
    expect(isWheelEvent(wheelUp) && wheelDirection(wheelUp) === 1).toBe(true);
    expect(isWheelEvent(wheelDown) && wheelDirection(wheelDown) === -1).toBe(
      true,
    );
    expect(isWheelEvent(wheelRelease)).toBe(false);
    expect(isLeftPress(leftPress)).toBe(true);
    expect(isLeftDrag(leftDrag)).toBe(true);
    expect(isLeftRelease(leftRelease0)).toBe(true);
    expect(isLeftRelease(leftRelease3)).toBe(true);
    expect(isLeftPress(rightPress) || isLeftDrag(rightPress)).toBe(false);
    expect(isLeftDrag(leftPress)).toBe(false);
    expect(isLeftPress(leftDrag)).toBe(false);
  });
});

describe("side-chat-messages.ts", () => {
  test("renders lines and strips ANSI", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    const rendered = messages.render(80);
    expect(
      stripTerminalSequences(rendered[0]).startsWith("[You]: hello world"),
    ).toBe(true);
  });

  test("highlights the selection in inverse video and extracts exact text", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 12 });
    const renderedSel = messages.render(80);
    expect(renderedSel[0]).toContain("\x1b[7m");
    expect(renderedSel[0]).toContain("\x1b[27m");
    expect(messages.getSelectedText()).toBe("hello");
    expect(messages.hasSelection()).toBe(true);
    messages.clearSelection();
    expect(messages.hasSelection()).toBe(false);
    expect(messages.render(80)[0]).not.toContain("\x1b[7m");
  });

  test("cross-line selection joins rendered lines", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    // rendered layout: user msg, blank separator, assistant msg, ...
    messages.setSelection({ line: 0, col: 5 }, { line: 2, col: 8 });
    expect(messages.getSelectedText()).toBe(
      ": hello world this is a long message\n\n[Assista",
    );
  });

  test("maps CJK wide characters cell→char consistently", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages([
      { role: "user", content: "你好世界hello", timestamp: 1 },
    ]);
    messages.render(80);
    // "[You]: " prefix = 7 cells, 你好 starts at cell 7
    messages.setSelection({ line: 0, col: 7 }, { line: 0, col: 13 });
    expect(messages.getSelectedText()).toBe("你好世");
  });

  test("scroll clears the selection", () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    messages.setSelection({ line: 0, col: 0 }, { line: 0, col: 5 });
    messages.scrollBy(1);
    expect(messages.hasSelection()).toBe(false);
  });

  test("appended status lines keep the selection anchored (blocker regression)", async () => {
    const messages = new SideChatMessages(theme, 10);
    messages.setMessages(DEFAULT_MESSAGES);
    messages.render(80);
    // Select the whole assistant line (line 2), like a double-click would.
    messages.setSelection({ line: 2, col: 0 }, { line: 2, col: 80 });
    const before = messages.getSelectedText();
    expect(before.startsWith("[Assistant]: assistant reply")).toBe(true);
    // Copy feedback appends a status line + blank line, shifting the window.
    messages.setToolStatus("✓ Copied 10 chars");
    const rendered = messages.render(80);
    // Selection must still resolve to the same content after the shift.
    expect(messages.getSelectedText()).toBe(before);
    // And the highlight must be on the correct (shifted) line.
    const shifted = rendered.findIndex((l) => l.includes("\x1b[7m"));
    expect(shifted).toBeGreaterThanOrEqual(0);
    expect(
      stripTerminalSequences(rendered[shifted]).startsWith(
        "[Assistant]: assistant reply",
      ),
    ).toBe(true);
    // Once the status clears, the selection keeps resolving to the content.
    messages.clearToolStatusIf("✓ Copied 10 chars");
    messages.render(80);
    expect(messages.getSelectedText()).toBe(before);
  });
});

describe("side-chat-overlay.ts", () => {
  test("geometry matches pi-tui resolveOverlayLayout for the overlay options", () => {
    const overlay = makeOverlay();
    const g = (overlay as any).geometry as {
      msgTopRow: number;
      contentCol: number;
      innerWidth: number;
      msgHeight: number;
    };
    expect(g.msgTopRow).toBe(4); // marginTop 1 + border/header/separator 3
    expect(g.contentCol).toBe(11); // leftCol 9 + border + padding 2
    expect(g.innerWidth).toBe(98); // width 102 - 4
    expect(g.msgHeight).toBeGreaterThanOrEqual(7);
    expect(g.msgHeight).toBeLessThanOrEqual(10);
  });

  test("wheel over the chat scrolls", () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    const before = M.getScrollOffset();
    overlay.handleMouseEvent({ button: 64, col: 20, row: 5, isRelease: false });
    expect(M.getScrollOffset()).toBeGreaterThanOrEqual(before);
  });

  test("drag-select keeps the selection on release; no auto-copy", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false }); // press at chat col 7
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false }); // drag to chat col 12
    expect(overlay.isMouseDragging()).toBe(true);
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true }); // release
    await tick();
    // No copy on release: selection is retained for the hotkey instead.
    expect(osc52CopiedText().length).toBe(0);
    const M: any = (overlay as any).messages;
    expect(M.hasSelection()).toBe(true);
    expect(M.getSelectedText()).toBe("hello");
  });

  test("ctrl+c copies the retained selection; no selection falls through", async () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(osc52CopiedText().length).toBe(0); // nothing copied at release
    overlay.handleInput("\x03"); // raw Ctrl+C terminal byte
    await tick();
    expect(osc52CopiedText()[0]).toBe("hello");
    // ctrl+shift+c via kitty CSI-u (mod = shift|ctrl + 1 = 6) re-copies
    overlay.handleInput("\x1b[99;6u");
    await tick();
    expect(osc52CopiedText().length).toBe(1);
    // without a selection, ctrl+c must not copy (falls through to the editor)
    (overlay as any).messages.clearSelection();
    overlay.handleInput("\x03");
    await tick();
    expect(osc52CopiedText().length).toBe(0);
  });

  test("copy feedback shows in the status line (hotkey copy)", async () => {
    osc52Writes = [];
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    overlay.handleInput("\x03");
    await tick();
    const M: any = (overlay as any).messages;
    expect(M.render(80).some((l: string) => l.includes("Copied"))).toBe(true);
    osc52CopiedText(); // consume the copy this test produced
  });

  test("plain click clears the selection and does not copy", () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    overlay.handleMouseEvent({ button: 0, col: 13, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 13, row: 5, isRelease: true });
    expect(osc52CopiedText().length).toBe(0);
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("a quick click after a drag is not mistaken for a double-click", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    // drag once
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 32, col: 24, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 24, row: 5, isRelease: true });
    await tick();
    expect(M.hasSelection()).toBe(true);
    // quick plain click right after (would have been a double-click before):
    // it must clear the selection instead of line-selecting.
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    await tick();
    expect(M.hasSelection()).toBe(false);
    expect(osc52CopiedText().length).toBe(0);
  });

  test("double-click selects the whole line; copy is hotkey-only", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: false });
    overlay.handleMouseEvent({ button: 0, col: 18, row: 5, isRelease: true });
    await tick();
    // Whole rendered line selected, nothing copied yet.
    expect(M.getSelectedText().startsWith("[You]: hello world")).toBe(true);
    expect(osc52CopiedText().length).toBe(0);
    // Hotkey copies the line selection.
    overlay.handleInput("\x03");
    await tick();
    const copied = osc52CopiedText();
    expect(copied.length).toBe(1);
    expect(copied[0].startsWith("[You]: hello world")).toBe(true);
  });

  test("drag beyond the viewport clamps to the last line", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 14, row: 5, isRelease: false });
    overlay.handleMouseEvent({
      button: 32,
      col: 14,
      row: 40,
      isRelease: false,
    }); // way below
    const M: any = (overlay as any).messages;
    const clamped = M.getSelectedText();
    expect(clamped.length).toBeGreaterThan(0);
    expect(clamped).toContain("tool output");
    overlay.handleMouseEvent({ button: 0, col: 14, row: 40, isRelease: true });
    expect(M.hasSelection()).toBe(true);
    expect(osc52CopiedText().length).toBe(0); // no auto-copy on release
  });

  test("click on the header row is not captured as a drag", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 16, row: 2, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("anchor survives a mid-drag status append (review nit)", async () => {
    // Enough content to overflow the viewport so the appended status line
    // actually shifts the window (delta > 0).
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setMessages(
      Array.from({ length: 6 }, (_, i) => ({
        role: "user",
        content: `message number ${i}`,
      })),
    );
    overlay.render(WIDTH);
    // Rendered: m0, blank, m1, blank, ... m5, blank (12 lines). Window shows
    // the last 9: content lines 3..11 → m1..m5. Press on window line 4 =
    // content line 7 = m3's line, chat col 7 = "m" of "message".
    overlay.handleMouseEvent({
      button: 0,
      col: 19,
      row: 4 + 4,
      isRelease: false,
    }); // chat col 7
    overlay.handleMouseEvent({
      button: 32,
      col: 24,
      row: 4 + 4,
      isRelease: false,
    }); // chat col 12
    M.setToolStatus("✓ Copied 5 chars"); // appends 2 lines → window shifts down
    overlay.render(WIDTH);
    // Release at the same screen position. The anchor must have been
    // translated with the window, so the selection starts at the content
    // that was under the pointer at press time (m3), not the shifted m4.
    overlay.handleMouseEvent({
      button: 0,
      col: 24,
      row: 4 + 4,
      isRelease: true,
    });
    // The retained selection is copied by the hotkey, with the same anchor.
    expect(M.getSelectedText()).toContain("message number 3");
    overlay.handleInput("\x03");
    await tick();
    const copied = osc52CopiedText();
    expect(copied.length).toBe(1);
    expect(copied[0]).toContain("message number 3");
  });

  test("cancelMouseDrag aborts an in-flight drag", () => {
    const overlay = makeOverlay();
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: false });
    expect(overlay.isMouseDragging()).toBe(true);
    overlay.cancelMouseDrag();
    expect(overlay.isMouseDragging()).toBe(false);
    // the stale press must not swallow a later unrelated event
    overlay.handleMouseEvent({ button: 0, col: 19, row: 5, isRelease: true });
    expect(overlay.isMouseDragging()).toBe(false);
  });

  test("copy failure surfaces an error status", async () => {
    const overlay = makeOverlay();
    const M: any = (overlay as any).messages;
    M.setSelection({ line: 0, col: 0 }, { line: 0, col: 3 });
    // Break the OSC 52 fallback so the whole cascade fails.
    const origWrite = (process.stdout as any).write;
    (process.stdout as any).write = () => {
      throw new Error("stdout closed");
    };
    const failed = await (overlay as any).copySelectionToClipboard();
    (process.stdout as any).write = origWrite;
    expect(failed).toBe(false);
    expect(M.render(80).some((l: string) => l.includes("Copy failed"))).toBe(
      true,
    );
  });
});
