import type { OverlayOptions } from "@earendil-works/pi-tui";

export type SideChatLayout = "compact" | "floating" | "fullscreen" | "right";

export function sideChatOverlayOptions(layout: SideChatLayout): OverlayOptions {
  if (layout === "compact") {
    return { width: "85%", maxHeight: "88%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 }, nonCapturing: true };
  }
  return layout === "floating"
    ? { width: "90%", maxHeight: "92%", anchor: "center", margin: { top: 1, bottom: 1, left: 2, right: 2 }, nonCapturing: true }
    : { width: layout === "right" ? "50%" : "100%", maxHeight: "100%", anchor: layout === "right" ? "top-right" : "top-left", margin: 0, nonCapturing: true };
}

/** maxHeight clips but never stretches a component: explicitly fill the preset. */
export function sideChatLayoutHeight(rows: number, layout: SideChatLayout): number {
  if (layout === "compact") {
    // Restore the original message-area budget plus its seven chrome rows.
    // Keep the newer rendering, but preserve the old window's actual size.
    const original = Math.max(3, Math.floor(rows * 0.35) - 10);
    const cap = Math.max(9, Math.min(Math.floor(rows * 0.88), rows - 4));
    const height = Math.max(3, Math.min(Math.round(original * 2.5), cap - 7)) + 7;
    return Math.max(1, Math.min(height, Math.floor(rows * 0.88), rows - 1));
  }
  return Math.max(1, layout === "floating" ? Math.min(Math.floor(rows * 0.92), rows - 2) : rows);
}
