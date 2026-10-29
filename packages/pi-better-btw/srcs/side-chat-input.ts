import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, type Editor } from "@earendil-works/pi-tui";
import { paintPanel, type PanelPalette } from "./side-chat-panel.ts";

// Locate Pi's opaque fake-cursor wrapper through its public renderer. Unlike
// CURSOR_MARKER, this marker also exists when the editor temporarily loses focus.
const FAKE_CURSOR_PREFIX = renderFakeCursor("\0").split("\0")[0]!;

export interface SideChatInputFrame {
  lines: string[];
  /** Native editor content rectangle, relative to this card's first row. */
  editor: { top: number; left: number; height: number; width: number; sourceOffset: number; sourceHeight: number };
}

/** Keep native wrapping/cursor/paste semantics; only compose and crop its rendered rows. */
export function renderSideChatInput(
  editor: Editor, theme: Theme, width: number, maxHeight: number, palette?: PanelPalette,
): SideChatInputFrame {
  // Native wrapping needs two cells plus its cursor reserve for CJK glyphs.
  const inset = Math.min(2, Math.max(0, Math.floor((width - 3) / 2)));
  const cardWidth = Math.max(3, width - inset * 2);
  const paddingX = cardWidth >= 8 ? 1 : 0;
  const gutter = cardWidth >= 6 ? 2 : 0;
  const editorWidth = cardWidth - paddingX * 2 - gutter;
  const paddingY = maxHeight >= 3 ? 1 : 0;
  const contentLimit = Math.max(1, Math.min(5, maxHeight - paddingY * 2));
  const source = editor.render(editorWidth);
  // No autocomplete provider is installed on the side editor. Remove exactly
  // its two border rows, never whitespace-only draft rows (intentional newlines).
  const content = source.slice(1, -1);
  const cursorRow = content.findIndex((line) => line.includes(CURSOR_MARKER) || line.includes(FAKE_CURSOR_PREFIX));
  const offset = Math.max(0, Math.min(
    (cursorRow < 0 ? content.length - 1 : cursorRow) - contentLimit + 1,
    content.length - contentLimit,
  ));
  const visible = content.slice(offset, offset + contentLimit);
  if (!editor.getText() && editorWidth > 1) {
    // Presentation only: the draft stays empty and its cursor remains in column 0.
    const cursor = (editor.focused ? CURSOR_MARKER : "") + renderFakeCursor(" ");
    visible[0] = cursor + theme.fg("dim", truncateToWidth("问点什么…", editorWidth - 1, "", true));
  }
  const margin = paintPanel(theme, "body", "", inset, palette);
  const row = (text = "") => margin + paintPanel(theme, "input", text, cardWidth, palette) + margin;
  const lines: string[] = [];
  if (paddingY) lines.push(row());
  for (let i = 0; i < visible.length; i++) {
    const prefix = gutter ? (i === 0 ? theme.fg(editor.focused ? "accent" : "dim", "› ") : "  ") : "";
    lines.push(row(" ".repeat(paddingX) + prefix + visible[i] + " ".repeat(paddingX)));
  }
  if (paddingY) lines.push(row());
  return {
    lines,
    editor: { top: paddingY, left: inset + paddingX + gutter, height: visible.length,
      width: editorWidth, sourceOffset: offset + 1, sourceHeight: source.length },
  };
}
