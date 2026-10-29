import { type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, SelectList, getKeybindings, matchesKey, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import { paintPanel, type PanelPalette } from "./side-chat-panel.ts";
import { actionShortcutLabel, shortcutHint } from "./side-chat-help.ts";

/** A keyboard-accessible modal card inside the side-chat overlay. */
export class SideChatDialog {
  private input = new Input({ prompt: "Search: ", placeholder: "model or provider" });
  private list: SelectList;
  private filtered: SelectItem[];
  private visibleRows = 6;
  constructor(
    private theme: Theme,
    private title: string,
    private items: SelectItem[],
    private searchable: boolean,
    selectedIndex: number,
    private onSelect: (value: string) => void,
    private onCancel: () => void,
    private description = "",
  ) {
    this.filtered = items;
    this.list = this.createList(items);
    this.list.setSelectedIndex(Math.max(0, selectedIndex));
    this.input.focused = true;
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.visibleRows, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    list.onSelect = (item) => this.onSelect(item.value);
    list.onCancel = this.onCancel;
    return list;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.onCancel(); return; }
    const bindings = getKeybindings();
    if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((action) => bindings.matches(data, action))) {
      this.list.handleInput(data);
    } else if (this.searchable) {
      const before = this.input.getValue();
      this.input.handleInput(data);
      const query = this.input.getValue().toLowerCase();
      if (before !== this.input.getValue()) {
        const terms = query.split(/\s+/).filter(Boolean);
        this.filtered = this.items.filter((item) =>
          terms.every((term) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(term)),
        );
        this.list = this.createList(this.filtered);
      }
    }
  }

  render(width: number, height: number, theme: Theme, palette?: PanelPalette): string[] {
    const cardWidth = Math.max(1, Math.min(76, width - 4));
    const innerWidth = Math.max(1, cardWidth - 4);
    const header = [
      ...(height >= 14 ? [""] : []),
      ...(height > 2 ? [theme.fg("accent", this.title)] : []),
      ...(height >= 12 && this.description ? [this.description] : []),
      ...(height >= 5 && this.searchable ? this.input.render(innerWidth) : []),
      ...(height >= 10 ? [""] : []),
    ];
    const bindings = getKeybindings();
    const footer = [
      ...(height >= 10 ? [""] : []),
      ...(height >= 4 ? [[
        shortcutHint(`${actionShortcutLabel(bindings, "tui.select.up", "↑")} / ${actionShortcutLabel(bindings, "tui.select.down", "↓")}`, "choose", theme),
        shortcutHint(actionShortcutLabel(bindings, "tui.select.confirm", "Enter"), "confirm", theme), shortcutHint("Esc", "back", theme),
      ].join(" · ")] : []),
      ...(height >= 14 ? [""] : []),
    ];
    // Reserve the list's optional scroll-info row. Resize the viewport *before*
    // rendering so the selected entry is never sliced off on short terminals.
    const visibleRows = Math.max(1, Math.min(6, height - header.length - footer.length - 1));
    if (visibleRows !== this.visibleRows) {
      const selected = this.list.getSelectedItem()?.value;
      this.visibleRows = visibleRows;
      this.list = this.createList(this.filtered);
      this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((item) => item.value === selected)));
    }
    const content = [...header, ...this.list.render(innerWidth), ...footer].slice(0, Math.max(1, height));
    const left = Math.max(0, Math.floor((width - cardWidth) / 2));
    const top = Math.max(0, Math.floor((height - content.length) / 2));
    const blank = paintPanel(theme, "body", "", width, palette);
    const lines = Array.from({ length: height }, () => blank);
    for (let i = 0; i < content.length; i++) {
      const card = paintPanel(theme, "input", `  ${content[i]}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content[i])))}  `, cardWidth, palette);
      lines[top + i] = paintPanel(theme, "body", "", left, palette) + card + paintPanel(theme, "body", "", width - left - cardWidth, palette);
    }
    return lines;
  }
}
