import { describe, expect, test } from "bun:test";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SideChatHelp, SIDE_CHAT_SHORTCUT_GROUPS } from "../srcs/side-chat-help.ts";
import { buildSideChatHintLines } from "../srcs/side-chat-overlay.ts";
import { SideChatDialog } from "../srcs/side-chat-dialog.ts";
import { currentTheme, layoutTheme as theme } from "./theme-fixture.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

describe("side-chat shortcut page", () => {
  test("common hints use theme text/muted colors and no obscure actions", () => {
    const lines = buildSideChatHintLines(100, undefined, currentTheme);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(currentTheme.fg("text", "Esc") + " " + currentTheme.fg("muted", "close"));
    expect(lines[0]).toContain(currentTheme.fg("text", "?"));
    const text = lines.map(stripTerminalSequences).join("\n");
    expect(text).toContain("Ctrl+P model");
    expect(text).toContain("Shift+Tab think");
    expect(text).not.toMatch(/export|fork|Alt\+M|Ctrl\+Alt\+W/);
    for (const width of [1, 6, 10, 20, 36, 50, 56, 80, 100]) {
      const compact = buildSideChatHintLines(width);
      expect(compact.length).toBeLessThanOrEqual(1);
      expect(compact.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (compact.length) expect(stripTerminalSequences(compact[0]!)).toContain("? keys");
    }
  });

  test("responsive columns fit widths/heights and every shortcut is reachable by scrolling", () => {
    for (const [width, height] of [[40, 8], [70, 16], [110, 30], [160, 35]]) {
      const page = new SideChatHelp(() => {});
      const seen: string[] = [];
      for (let i = 0; i < 120; i++) {
        const lines = page.render(width!, height!, theme);
        expect(lines).toHaveLength(height!);
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        seen.push(...lines.map(stripTerminalSequences));
        page.handleInput("\x1b[B");
      }
      const text = seen.join("\n");
      for (const group of SIDE_CHAT_SHORTCUT_GROUPS) {
        expect(text).toContain(group.title);
        for (const [key] of group.items) expect(text).toContain(key);
      }
      page.handleInput("\x1b[H");
      expect(page.render(width!, height!, theme).map(stripTerminalSequences).join("\n")).toContain("Conversation");
    }
  });

  test("hints and help show effective remapped model/thinking bindings", () => {
    const bindings: any = { getKeys: (action: string) => ({
      "app.model.cycleForward": ["ctrl+g"], "app.model.cycleBackward": ["ctrl+shift+g"], "app.thinking.cycle": ["alt+h"],
    })[action] };
    const hints = buildSideChatHintLines(100, bindings).map(stripTerminalSequences).join("\n");
    expect(hints).toContain("Ctrl+G model");
    expect(hints).toContain("Alt+H think");
    const page = new SideChatHelp(() => {}, bindings);
    const text = page.render(180, 60, theme).map(stripTerminalSequences).join("\n");
    expect(text).toContain("Ctrl+G");
    expect(text).toContain("Ctrl+Shift+G");
    expect(text).not.toContain("Ctrl+P");
    expect(text).not.toContain("Shift+Tab");
  });

  test("dialogs honor remapped TUI selection and confirmation bindings", () => {
    const original = getKeybindings();
    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+j", "tui.select.confirm": "ctrl+y" });
    setKeybindings(bindings);
    try {
      let selected = "";
      const dialog = new SideChatDialog(theme, "Test", [
        { value: "keep", label: "Keep" }, { value: "close", label: "Close" },
      ], true, 0, (value) => { selected = value; }, () => {});
      dialog.handleInput("\x0a"); // Ctrl+J
      dialog.handleInput("\x19"); // Ctrl+Y
      expect(selected).toBe("close");
      const text = dialog.render(100, 18, theme).map(stripTerminalSequences).join("\n");
      expect(text).toContain("Ctrl+Y confirm");
    } finally { setKeybindings(original); }
  });

  test("title and bottom hint have generous padding at normal size", () => {
    const lines = new SideChatHelp(() => {}).render(120, 30, theme).map(stripTerminalSequences);
    expect(lines.slice(0, 2).every((line) => !line.trim())).toBe(true);
    expect(lines[2]).toStartWith("    Side chat shortcuts");
    expect(lines.slice(-2).every((line) => !line.trim())).toBe(true);
    expect(lines.at(-3)).toStartWith("    Esc back");
    for (const arrow of ["←", "↑", "→", "↓"]) expect(lines.join("\n")).toContain(`Ctrl+Alt+${arrow}`);
    expect(lines.join("\n")).toContain("Ctrl+↑");
    expect(lines.join("\n")).toContain("Ctrl+↓");
  });

  test("Esc or ? returns without invoking a close action", () => {
    let backs = 0;
    const page = new SideChatHelp(() => { backs++; });
    page.handleInput("\x1b");
    page.handleInput("?");
    expect(backs).toBe(2);
  });
});
