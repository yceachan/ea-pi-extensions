import { FooterComponent, type ExtensionUIContext, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type SideChatStatus = "idle" | "busy" | null;
const STATUS_KEY = "pibtw.side-chat";

export function sideChatBadge(status: Exclude<SideChatStatus, null>): string {
  return `[\x1b[${status === "busy" ? 33 : 32}m●\x1b[39m side chat]`;
}

export function appendSideChatBadge(line: string, width: number, badge: string): string {
  const room = Math.max(0, width - visibleWidth(badge) - 1);
  const content = truncateToWidth(line, room, "");
  return truncateToWidth(content + " ".repeat(Math.max(0, width - visibleWidth(content) - visibleWidth(badge))) + badge, width, "");
}

/**
 * Pi has no model-row slot. Adapt its exported default footer, leaving custom
 * footers untouched. Always publish a keyed status so runtime footer changes
 * retain the indicator. The default footer omits only our keyed entry from its
 * status row, displaying it beside the model instead. No shared data is mutated.
 */
export class SideChatStatusIndicator {
  private status: SideChatStatus = null;
  private ui: ExtensionUIContext | null = null;
  private readonly original = FooterComponent.prototype.render;
  private readonly patched: FooterComponent["render"];
  private disposed = false;

  constructor() {
    const indicator = this;
    const original = this.original;
    this.patched = function (width: number): string[] {
      const lines = original.call(this, width);
      const status = indicator.status;
      if (!status || lines.length < 2) return lines;
      // This small, isolated adapter depends on Pi 1.4's default footer layout.
      // If its internals change, leave the public keyed-status fallback alone.
      const data = (this as unknown as { footerData?: ReadonlyFooterDataProvider }).footerData;
      if (!data?.getExtensionStatuses) return lines;
      const statuses = data.getExtensionStatuses();
      const expectedStatus = [...statuses.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
        .join(" ");
      // Do not delete/rearrange an unknown footer row. If the default layout
      // no longer matches, its normal status row still contains our badge.
      if (!statuses.has(STATUS_KEY) || lines.length !== 3 ||
          stripTerminalSequences(lines[2] ?? "") !==
          stripTerminalSequences(truncateToWidth(expectedStatus, width, "..."))) return lines;
      if (statuses.has(STATUS_KEY)) {
        const others = [...statuses.entries()]
          .filter(([key]) => key !== STATUS_KEY)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
        lines.splice(2, 1, ...(others.length ? [truncateToWidth(others.join(" "), width, "…")] : []));
      }
      const badge = sideChatBadge(status);
      const compact = original.call(this, Math.max(1, width - visibleWidth(badge) - 1));
      lines[1] = appendSideChatBadge(compact[1] ?? "", width, badge);
      return lines;
    };
    FooterComponent.prototype.render = this.patched;
  }

  update(ui: ExtensionUIContext, status: SideChatStatus): void {
    if (this.disposed) return;
    this.ui = ui;
    this.status = status;
    ui.setStatus(STATUS_KEY, status ? sideChatBadge(status) : undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = null;
    this.ui?.setStatus(STATUS_KEY, undefined);
    if (FooterComponent.prototype.render === this.patched) FooterComponent.prototype.render = this.original;
  }
}
