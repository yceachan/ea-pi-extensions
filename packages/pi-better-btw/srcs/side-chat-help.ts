import type { AppKeybinding, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { paintPanel, type PanelPalette } from "./side-chat-panel.ts";

/** Semantic colors stay readable in light, dark and custom Pi themes. */
export const shortcutKey = (text: string, theme?: Theme): string => theme ? theme.fg("text", text) : text;
export const shortcutDescription = (text: string, theme?: Theme): string => theme ? theme.fg("muted", text) : text;
export const shortcutHint = (key: string, description: string, theme?: Theme): string =>
  `${shortcutKey(key, theme)} ${shortcutDescription(description, theme)}`;

export type ShortcutBindings = Partial<Pick<KeybindingsManager, "getKeys">>;

export function actionShortcutLabel<Action extends string>(bindings: { getKeys?: (action: Action) => readonly string[] } | undefined, action: Action, fallback: string): string {
  const keys = bindings?.getKeys?.(action);
  if (!keys) return fallback;
  return keys.length ? keys.map((key) => key.split("+").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("+")).join(" / ") : "Unbound";
}

export const SIDE_CHAT_SHORTCUT_GROUPS = [
  { title: "Conversation", items: [
    ["Enter", "Send message"], ["Shift+Enter", "Insert new line"],
    ["Esc", "Close (with confirmation)"], ["Alt+W", "Hide / restore (keep running)"],
    ["Alt+S", "Stop response, keep history"], ["?", "Show shortcuts (empty draft)"],
  ] },
  { title: "Models & thinking", items: [
    ["Ctrl+P", "Next model"], ["Ctrl+Shift+P", "Previous model"],
    ["Alt+P", "Previous model (Windows)"], ["Shift+Tab", "Next thinking level"],
    ["Alt+M", "Search / select model"], ["Alt+T", "Select thinking level"],
  ] },
  { title: "Tools & context", items: [
    ["Ctrl+T", "Read-only / edit mode"], ["Alt+R", "Re-fork latest main context"],
    ["Alt+N", "Start empty conversation"], ["Alt+E", "Export conversation"],
    ["/btw-close", "Close from the main editor"],
  ] },
  { title: "Layout", items: [
    ["Ctrl+Alt+←", "Full screen"], ["Ctrl+Alt+↑", "Original small window"],
    ["Ctrl+Alt+↓", "Large centered window"], ["Ctrl+Alt+→", "Right half"],
  ] },
  { title: "Scroll & copy", items: [
    ["Ctrl+↑", "Previous message"], ["Ctrl+↓", "Next message"],
    ["PgUp/PgDn", "Scroll a page"], ["Shift+↑/↓", "Scroll three lines"],
    ["Wheel", "Scroll conversation"], ["Drag", "Select text"],
    ["Double-click", "Select whole line"], ["Ctrl+C", "Copy selected text"],
    ["Ctrl+Shift+C", "Copy selected text"],
  ] },
] as const;

/** Dedicated, responsive shortcut page. Esc returns without touching the agent. */
export class SideChatHelp {
  private offset = 0;
  private pageSize = 1;
  private maxOffset = 0;
  constructor(private onBack: () => void, private bindings?: ShortcutBindings) {}

  scrollBy(lines: number): void {
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + lines));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "?") { this.onBack(); return; }
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.pageSize);
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.pageSize);
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = this.maxOffset;
  }

  render(width: number, height: number, theme: Theme, palette?: PanelPalette): string[] {
    const paddingX = Math.min(width >= 70 ? 4 : 2, Math.max(0, Math.floor((width - 1) / 2)));
    const innerWidth = Math.max(1, width - paddingX * 2);
    const columns = Math.max(1, Math.min(3, Math.floor((innerWidth + 3) / 34)));
    const columnWidth = Math.max(1, Math.floor((innerWidth - (columns - 1) * 3) / columns));
    const content: string[][] = Array.from({ length: columns }, () => []);
    const modelActions = new Map<string, AppKeybinding>([
      ["Ctrl+P", "app.model.cycleForward"], ["Ctrl+Shift+P", "app.model.cycleBackward"], ["Shift+Tab", "app.thinking.cycle"],

    ]);
    const groups = SIDE_CHAT_SHORTCUT_GROUPS.map((group) => ({
      title: group.title,
      items: group.items.map(([key, description]) => [
        key === "Ctrl+↑" ? actionShortcutLabel(getKeybindings(), "tui.altScreen.previousPrompt", key).replace(/Up/g, "↑")
          : key === "Ctrl+↓" ? actionShortcutLabel(getKeybindings(), "tui.altScreen.nextPrompt", key).replace(/Down/g, "↓")
          : modelActions.has(key) ? actionShortcutLabel(this.bindings, modelActions.get(key)!, key) : key, description,
      ] as const),
    }));
    groups.forEach((group, index) => {
      const lines = content[index % columns]!;
      lines.push(shortcutKey(group.title, theme), "");
      const keyWidth = Math.max(1, Math.min(Math.floor(columnWidth / 2), Math.max(...group.items.map(([key]) => visibleWidth(key)))));
      for (const [key, description] of group.items) {
        const descriptionWidth = Math.max(1, columnWidth - keyWidth - 2);
        const keys = wrapTextWithAnsi(shortcutKey(key, theme), keyWidth);
        const descriptions = wrapTextWithAnsi(shortcutDescription(description, theme), descriptionWidth);
        for (let i = 0; i < Math.max(keys.length, descriptions.length); i++) {
          const keyLine = keys[i] ?? "";
          lines.push(keyLine + " ".repeat(Math.max(0, keyWidth - visibleWidth(keyLine))) + "  " + (descriptions[i] ?? ""));
        }
      }
      lines.push("");
    });
    const all = Array.from({ length: Math.max(...content.map((lines) => lines.length)) }, (_, row) =>
      content.map((lines) => {
        const line = truncateToWidth(lines[row] ?? "", columnWidth, "");
        return line + " ".repeat(Math.max(0, columnWidth - visibleWidth(line)));
      }).join("   "),
    );
    const paddingY = height >= 14 ? 2 : height >= 7 ? 1 : 0;
    const blanks = Array.from({ length: paddingY }, () => "");
    const header = height >= 5 ? [...blanks, shortcutKey("Side chat shortcuts", theme), ""] : [];
    const footer = height >= 3 ? ["", [shortcutHint("Esc", "back", theme), shortcutHint("↑↓ / PgUp/PgDn", "scroll", theme)].join(" · "), ...blanks] : [];
    this.pageSize = Math.max(1, height - header.length - footer.length);
    this.maxOffset = Math.max(0, all.length - this.pageSize);
    this.offset = Math.min(this.offset, this.maxOffset);
    const body = all.slice(this.offset, this.offset + this.pageSize);
    while (body.length < this.pageSize) body.push("");
    return [...header, ...body, ...footer].slice(0, height).map((line) =>
      paintPanel(theme, "body", `${" ".repeat(paddingX)}${truncateToWidth(line, innerWidth, "")}${" ".repeat(paddingX)}`, width, palette),
    );
  }
}
