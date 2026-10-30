import { describe, expect, test } from "bun:test";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SideChatStatusIndicator, appendSideChatBadge, sideChatBadge } from "../srcs/side-chat-status.ts";

describe("main-footer side-chat indicator", () => {
  test("fits narrow widths, ANSI and wide characters", () => {
    for (const width of [1, 8, 20, 40, 100]) {
      const line = appendSideChatBadge("费用 中文 · model-name", width, sideChatBadge("busy"));
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("moves only its keyed status to the model row, handles dynamic footer replacement and restores", () => {
    const original = FooterComponent.prototype.render;
    const statuses = new Map<string, string>([["other", "other extension"]]);
    const fake = { footerData: { getExtensionStatuses: () => statuses } } as unknown as FooterComponent;
    FooterComponent.prototype.render = function (width) {
      return ["cwd", "stats" + " ".repeat(Math.max(0, width - 10)) + "model", ...(
        statuses.size ? [[...statuses.values()].join(" ")] : []
      )];
    };
    const base = FooterComponent.prototype.render;
    const indicator = new SideChatStatusIndicator();
    const ui: any = { setStatus: (key: string, value: string | undefined) => {
      if (value === undefined) statuses.delete(key); else statuses.set(key, value);
    } };
    try {
      indicator.update(ui, "busy");
      const lines = FooterComponent.prototype.render.call(fake, 80);
      expect(lines[0]).toBe("cwd");
      expect(lines[2]).toBe("other extension");
      expect(stripTerminalSequences(lines[1]!)).toEndWith("model [● side chat]");
      expect(lines[1]).toContain("\x1b[33m●");
      expect(visibleWidth(lines[1]!)).toBe(80);
      // Switching to a custom footer needs no busy/idle transition: its public
      // status source already contains the current badge, even after default renders.
      expect(statuses.get("pibtw.side-chat")).toContain("\x1b[33m●");
      indicator.update(ui, "idle");
      expect(FooterComponent.prototype.render.call(fake, 80)[1]).toContain("\x1b[32m●");
      statuses.delete("other");
      expect(FooterComponent.prototype.render.call(fake, 80)).toHaveLength(2);
      indicator.update(ui, null);
      expect(statuses.has("pibtw.side-chat")).toBe(false);
      expect(FooterComponent.prototype.render.call(fake, 80)).toEqual(base.call(fake, 80));
      indicator.dispose();
      expect(FooterComponent.prototype.render).toBe(base);
    } finally {
      indicator.dispose();
      FooterComponent.prototype.render = original;
    }
  });

  test("integrates with the real Pi default footer renderer", () => {
    initTheme("dark");
    const statuses = new Map<string, string>([["external", "external status"]]);
    const model = { id: "main-model", provider: "test", reasoning: false, contextWindow: 128000 };
    const session: any = {
      state: { model, thinkingLevel: "off" }, model,
      modelRuntime: { isUsingSubscription: () => false },
      getContextUsage: () => ({ percent: 0, contextWindow: 128000 }),
      sessionManager: {
        getEntryCount: () => 0, getSessionId: () => "test", getLeafId: () => null,
        getEntries: () => [], getCwd: () => "test-project", getSessionName: () => undefined,
      },
    };
    const footer = new FooterComponent(session, {
      getGitBranch: () => null, getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses, onBranchChange: () => () => {},
    });
    const indicator = new SideChatStatusIndicator();
    const ui: any = { setStatus: (key: string, value: string | undefined) => {
      if (value === undefined) statuses.delete(key); else statuses.set(key, value);
    } };
    try {
      indicator.update(ui, "idle");
      const lines = footer.render(120);
      expect(stripTerminalSequences(lines[1]!)).toEndWith("main-model [● side chat]");
      expect(lines[1]).toContain("\x1b[32m●");
      expect(lines[2]).toBe("external status");
      expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
      indicator.update(ui, null);
      expect(footer.render(120).map(stripTerminalSequences).join("\n")).not.toContain("side chat");
    } finally { indicator.dispose(); }
  });

  test("unknown footer layouts retain their rows and use the keyed status fallback", () => {
    const original = FooterComponent.prototype.render;
    for (const extraRow of [false, true]) {
      const statuses = new Map<string, string>();
      const fake = { footerData: { getExtensionStatuses: () => statuses } } as unknown as FooterComponent;
      FooterComponent.prototype.render = () => extraRow
        ? ["cwd", "new summary", "model", [...statuses.values()].join(" ")]
        : ["cwd", [...statuses.values()].join(" "), "model"];
      const base = FooterComponent.prototype.render;
      const indicator = new SideChatStatusIndicator();
      const ui: any = { setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key); else statuses.set(key, value);
      } };
      try {
        indicator.update(ui, "busy");
        expect(FooterComponent.prototype.render.call(fake, 120)).toEqual(base.call(fake, 120));
        expect(statuses.get("pibtw.side-chat")).toContain("\x1b[33m●");
      } finally {
        indicator.dispose();
        FooterComponent.prototype.render = original;
      }
    }
  });

  test("custom footer gets the keyed status without waiting for a default render", () => {
    const indicator = new SideChatStatusIndicator();
    const statuses = new Map<string, string | undefined>();
    const ui: any = { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) };
    try {
      indicator.update(ui, "idle");
      expect(statuses.get("pibtw.side-chat")).toContain("\x1b[32m●");
      indicator.dispose();
      expect(statuses.get("pibtw.side-chat")).toBeUndefined();
    } finally { indicator.dispose(); }
  });
});
