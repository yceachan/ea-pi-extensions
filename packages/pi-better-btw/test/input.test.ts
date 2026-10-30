import { describe, expect, test } from "bun:test";
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderSideChatInput } from "../srcs/side-chat-input.ts";
import { layoutTheme as theme } from "./theme-fixture.ts";

initTheme("dark");
function makeEditor(text = "") {
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} } as unknown as TUI;
  const editor = new Editor(tui, { borderColor: (t) => t, selectList: getSelectListTheme() }, { paddingX: 0 });
  editor.focused = true;
  editor.setText(text);
  return editor;
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences);

describe("lightweight side-chat input card", () => {
  test("empty draft is a three-row inset card; prompt/placeholder never enter the draft", () => {
    const editor = makeEditor();
    const card = renderSideChatInput(editor, theme, 80, 7);
    expect(card.lines).toHaveLength(3);
    expect(card.editor.top).toBe(1);
    expect(card.editor.left).toBe(5);
    expect(card.editor.height).toBe(1);
    expect(card.lines.every((line) => visibleWidth(line) === 80)).toBe(true);
    expect(plain(card.lines)[0]!.trim()).toBe("");
    expect(plain(card.lines)[1]).toContain("›  问点什么…");
    expect(plain(card.lines)[2]!.trim()).toBe("");
    expect(card.lines.join("").split(CURSOR_MARKER)).toHaveLength(2);
    expect(editor.getText()).toBe("");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput("你");
    const typed = renderSideChatInput(editor, theme, 80, 7);
    expect(editor.getText()).toBe("你");
    expect(plain(typed.lines).join("\n")).not.toContain("问点什么");
  });

  test("multiline drafts grow naturally, keeping intentional blank lines and trailing newline", () => {
    const editor = makeEditor("one\n\nthree\n");
    const card = renderSideChatInput(editor, theme, 80, 7);
    expect(card.lines).toHaveLength(6);
    expect(card.editor.height).toBe(4);
    const body = plain(card.lines).slice(1, -1);
    expect(body[0]).toContain("› one");
    expect(body[1]!.trim()).toBe("");
    expect(body[2]).toContain("three");
    expect(body[3]!.trim()).toBe("");
    expect(editor.getText()).toBe("one\n\nthree\n");
    expect(card.lines.join("")).toContain(CURSOR_MARKER);
  });

  test("long and wrapped drafts cap at five content rows while keeping the native cursor", () => {
    for (const text of [Array.from({ length: 30 }, (_, i) => `row-${i}`).join("\n"), "中文abcdefghij".repeat(40)]) {
      const editor = makeEditor(text);
      for (const width of [20, 47, 80]) {
        const card = renderSideChatInput(editor, theme, width, 7);
        expect(card.lines).toHaveLength(7);
        expect(card.editor.height).toBe(5);
        expect(card.lines.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(card.lines.join("").split(CURSOR_MARKER)).toHaveLength(2);
        expect(editor.getText()).toBe(text);
      }
    }
  });

  test("crop offsets dispatch native mouse clicks to the correct draft line", () => {
    const draft = Array.from({ length: 12 }, (_, i) => `row-${i}`).join("\n");
    const editor = makeEditor(draft);
    const card = renderSideChatInput(editor, theme, 60, 7);
    expect(card.editor.sourceOffset).toBeGreaterThan(1);
    const logicalLine = Number(plain(card.lines)[card.editor.top]!.match(/row-(\d+)/)![1]);
    const event: TuiMouseEvent = { type: "click", button: "left", x: 0, y: card.editor.sourceOffset,
      screenX: card.editor.left, screenY: card.editor.top, width: card.editor.width, height: card.editor.sourceHeight,
      shift: false, alt: false, ctrl: false };
    editor.handleMouse(event);
    expect(editor.getCursor()).toEqual({ line: logicalLine, col: 0 });
    editor.handleInput("X");
    expect(editor.getText().split("\n")[logicalLine]).toBe(`Xrow-${logicalLine}`);
    expect(renderSideChatInput(editor, theme, 60, 7).lines.join("")).toContain(CURSOR_MARKER);
  });

  test("losing focus never jumps away from a cropped draft's cursor", () => {
    const editor = makeEditor(Array.from({ length: 10 }, (_, i) => `row-${i}`).join("\n"));
    for (let i = 0; i < 8; i++) editor.handleInput("\x1b[A");
    expect(editor.getCursor().line).toBe(1);
    const focused = renderSideChatInput(editor, theme, 60, 7);
    editor.focused = false;
    const unfocused = renderSideChatInput(editor, theme, 60, 7);
    expect(plain(unfocused.lines)).toEqual(plain(focused.lines));
    expect(unfocused.editor.sourceOffset).toBe(focused.editor.sourceOffset);
    expect(unfocused.lines.join("")).not.toContain(CURSOR_MARKER);
    editor.focused = true;
    expect(plain(renderSideChatInput(editor, theme, 60, 7).lines)).toEqual(plain(focused.lines));
    expect(editor.getCursor().line).toBe(1);
  });

  test("short/narrow cards sacrifice decorations before the cursor; bracketed paste remains native", () => {
    const editor = makeEditor();
    editor.handleInput("\x1b[200~hello\n世界\x1b[201~");
    expect(editor.getText()).toBe("hello\n世界");
    for (const width of [4, 6, 10, 20]) {
      for (const maxHeight of [1, 2, 3, 7]) {
        const card = renderSideChatInput(editor, theme, width, maxHeight);
        expect(card.lines.length).toBeLessThanOrEqual(maxHeight);
        expect(card.lines.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(card.lines.join("")).toContain(CURSOR_MARKER);
      }
    }
    expect(editor.getText()).toBe("hello\n世界");
  });
});
