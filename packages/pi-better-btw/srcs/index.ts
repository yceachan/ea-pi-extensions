import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, Terminal, TUI } from "@earendil-works/pi-tui";
import {
  buildSessionContext,
  ExtensionRunner,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";
import { FileActivityTracker } from "./file-activity-tracker.ts";
import { loadConfig } from "./config.ts";
import { getExtensionDir, loadPromptPack } from "./prompt-pack.ts";
import {
  SideChatOverlay,
  type ForkContext,
} from "./side-chat-overlay.ts";
import { SIDE_CHAT_SHORTCUT } from "./shortcuts.ts";
import { sideChatOverlayOptions } from "./side-chat-layout.ts";
import { SideChatStatusIndicator } from "./side-chat-status.ts";
import {
  disableMouseReporting,
  enableMouseReporting,
  parseSgrMouseEvent,
} from "./side-chat-mouse.ts";
import { extractWritePaths } from "./tool-wrapper.ts";

// Patch to capture the runner instance for extension tool access in side chat.
let capturedRunner: ExtensionRunner | null = null;
const origGetAllRegisteredTools =
  ExtensionRunner.prototype.getAllRegisteredTools;
ExtensionRunner.prototype.getAllRegisteredTools = function () {
  capturedRunner = this;
  return origGetAllRegisteredTools.call(this);
};

function getExtensionAgentTools(): AgentTool[] {
  if (!capturedRunner) return [];
  return wrapRegisteredTools(capturedRunner.getAllRegisteredTools(), capturedRunner);
}

const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

/** Extension directory: base for the bundle config.json and prompt-pack paths. */
const extensionDir = getExtensionDir();

export default function sideChatExtension(pi: ExtensionAPI) {
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayHandle: OverlayHandle | null = null;
  const indicator = new SideChatStatusIndicator();
  let sideSettings: Pick<ForkContext, "model" | "thinkingLevel"> | null = null;
  let mouseTerminal: Terminal | null = null;
  let removeMouseListener: (() => void) | null = null;

  /**
   * Regular mode needs a raw SGR listener. Fullscreen owns reporting and
   * dispatches normalized events directly to SideChatOverlay.handleMouse.
   */
  const installMouseHandler = (tui: TUI) => {
    if (tui.mode === "fullscreen" || removeMouseListener) return;
    enableMouseReporting(tui.terminal);
    mouseTerminal = tui.terminal;
    removeMouseListener = tui.addInputListener((data) => {
      const event = parseSgrMouseEvent(data);
      if (!event) return undefined;
      const overlay = activeOverlay;
      if (overlay && !overlayHandle?.isHidden()) {
        // An in-flight drag keeps consuming events even when the pointer
        // leaves the overlay, so the selection clamps to the edges.
        if (overlay.isMouseDragging()) {
          overlay.handleMouseEvent(event);
          return { consume: true };
        }
        const viewport = overlay.getViewport();
        const overOverlay =
          viewport !== null &&
          event.row - 1 >= viewport.topRow &&
          event.row - 1 < viewport.topRow + viewport.height &&
          event.col - 1 >= viewport.leftCol &&
          event.col - 1 < viewport.leftCol + viewport.width;
        if (overOverlay) {
          // A press on the chat focuses the overlay, so the subsequent
          // Ctrl+C / Ctrl+Shift+C lands in the overlay (not the main editor)
          // and re-copies the selection.
          if (
            !event.isRelease &&
            (event.button & 3) === 0 &&
            (event.button & 32) === 0
          ) {
            overlayHandle?.focus();
          }
          overlay.handleMouseEvent(event);
        }
      }
      // Always consume: mouse sequences must never leak into the editor as
      // garbage input. This listener is installed only in regular mode.
      return { consume: true };
    });
  };

  const uninstallMouseHandler = () => {
    if (!removeMouseListener) return;
    removeMouseListener();
    removeMouseListener = null;
    if (mouseTerminal) {
      disableMouseReporting(mouseTerminal);
      mouseTerminal = null;
    }
  };

  /**
   * Regular-mode reporting follows visibility. Fullscreen reporting belongs
   * to Pi and must remain untouched when the overlay is hidden or closed.
   */
  const syncMouseReporting = () => {
    if (overlayHandle?.isHidden()) activeOverlay?.cancelMouseDrag();
    if (!removeMouseListener || !mouseTerminal) return;
    if (overlayHandle?.isHidden()) {
      disableMouseReporting(mouseTerminal);
    } else {
      enableMouseReporting(mouseTerminal);
    }
  };

  /** Toggle the side chat between hidden (backgrounded) and visible. Opens it if needed. */
  const backgroundSideChat = async (ctx: ExtensionContext) => {
    if (!activeOverlay) return openSideChat(ctx);
    const handle = overlayHandle;
    if (!handle) return;
    if (handle.isHidden()) {
      handle.setHidden(false);
      handle.focus();
      syncMouseReporting();
    } else {
      handle.unfocus();
      handle.setHidden(true);
      syncMouseReporting();
    }
  };

  pi.on("tool_execution_start", (event, ctx) => {
    if (["write", "edit", "bash"].includes(event.toolName)) {
      const paths = extractWritePaths(event.toolName, event.args);
      paths.forEach((p) => tracker.trackWrite(p, ctx.cwd));
    }
  });

  const toggleSideChat = async (ctx: ExtensionContext) => {
    if (activeOverlay) {
      const handle = overlayHandle;
      if (!handle) return;
      if (handle.isHidden()) {
        // Hidden in the background: restore and focus.
        handle.setHidden(false);
        handle.focus();
        syncMouseReporting();
        return;
      }
      // The Alt+/ focus toggle was dropped (Alt+W owns background/restore):
      // the open key only ever brings the chat to the front — a visible but
      // unfocused overlay (e.g. after a mouse refocus) comes back this way,
      // and pressing it while focused is a no-op.
      if (!handle.isFocused()) {
        handle.focus();
      }
      return;
    }
    return openSideChat(ctx);
  };

  const openSideChat = async (ctx: ExtensionContext, clear = false) => {
    if (!ctx.model) {
      ctx.ui.notify("Cannot open side chat: no model configured", "error");
      return;
    }

    const sessionContext = buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    );
    // Layered config (#18): bundle <ExtensionDir>/config.json defaults, then
    // ~/.pi/agent/pi-better-btw/config.json (user), then
    // <cwd>/.pi/pi-better-btw/config.json (project) — allowlists union,
    // promptPack merges per key.
    // Read fresh at every open (no cache), consistent with the prompt pack.
    const config = loadConfig({
      extensionDir,
      cwd: ctx.cwd,
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
    // Prompt pack (#13): read fresh at every fork (no cache) so edits to the
    // manifest files apply on the next fork; per-key fallback + notify.
    const promptPack = loadPromptPack(config.promptPack, {
      extensionDir,
      notify: (message) => ctx.ui.notify(message, "warning"),
    });
    const forkContext: ForkContext = {
      messages: clear ? [] : sessionContext.messages,
      model: sideSettings?.model ?? ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: sideSettings?.thinkingLevel ?? pi.getThinkingLevel(),
      cwd: ctx.cwd,
      extensionTools: getExtensionAgentTools(),
    };
    // Copy once: later main-session model/thinking changes never affect the side agent.
    sideSettings = { model: forkContext.model, thinkingLevel: forkContext.thinkingLevel };

    // Pi 1.4 retains this options object by reference and resolves it each
    // frame. Its handle has no update API; mutating this one object lets us
    // reposition the existing component without losing its agent or draft.
    const overlayOptions = sideChatOverlayOptions("floating");
    try {
      const action = await ctx.ui.custom<"close" | "refork" | "clear">(
        (tui, theme, keybindings, done) => {
          if (tui.hasOverlay()) {
            setTimeout(() => {
              ctx.ui.notify(
                "Close or background the current overlay first",
                "warning",
              );
            }, 0);
            throw new Error(OVERLAY_BLOCKED_ERROR);
          }

          activeOverlay = new SideChatOverlay({
            tui,
            theme,
            forkContext,
            tracker,
            modelRegistry: ctx.modelRegistry,
            getScopedModels: () => ctx.scopedModels ?? [],
            keybindings,
            getBounds: () => overlayHandle?.getBounds(),
            onLayoutChange: (layout) => { Object.assign(overlayOptions, sideChatOverlayOptions(layout)); },
            sessionManager: ctx.sessionManager,
            promptPack,
            readOnlyExtensionAllowlist: config.readOnlyExtensionAllowlist,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onBusyChange: (busy) => indicator.update(ctx.ui, busy ? "busy" : "idle"),
            onSettingsChange: (model, thinkingLevel) => { sideSettings = { model, thinkingLevel }; },
            onBackground: () => {
              overlayHandle?.unfocus();
              overlayHandle?.setHidden(true);
              syncMouseReporting();
            },
            onExport: (path) =>
              ctx.ui.notify(`btw chat exported → ${path}`, "info"),
            onClose: (action) => {
              indicator.update(ctx.ui, null);
              activeOverlay = null;
              overlayHandle = null;
              uninstallMouseHandler();
              done(action);
            },
          });
          installMouseHandler(tui);
          indicator.update(ctx.ui, "idle");
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions,
          onHandle: (handle) => {
            overlayHandle = handle;
            handle.focus();
          },
        },
      );
      if (action === "refork") return openSideChat(ctx);
      if (action === "clear") return openSideChat(ctx, true);
    } catch (error) {
      if (error instanceof Error && error.message === OVERLAY_BLOCKED_ERROR) {
        return;
      }
      activeOverlay = null;
      overlayHandle = null;
      indicator.update(ctx.ui, null);
      uninstallMouseHandler();
      throw error;
    }
  };

  pi.registerShortcut(SIDE_CHAT_SHORTCUT, {
    description: "Open / background / restore the side chat (keeps it running)",
    handler: backgroundSideChat,
  });

  const requestClose = async () => {
    if (!activeOverlay) return;
    overlayHandle?.setHidden(false);
    overlayHandle?.focus();
    syncMouseReporting();
    activeOverlay.requestClose();
  };
  pi.registerCommand("btw-close", {
    description: "Close side chat (with confirmation)",
    handler: requestClose,
  });
  // Session changes are lifecycle teardown, not a user close request.
  pi.on("session_start", () => { activeOverlay?.dispose(); sideSettings = null; });
  pi.on("session_shutdown", () => {
    activeOverlay?.dispose();
    uninstallMouseHandler();
    indicator.dispose();
  });

  pi.registerCommand("side", {
    description: "Open side chat (fork conversation)",
    handler: (_, ctx) => toggleSideChat(ctx),
  });

  pi.registerCommand("btw", {
    description: "Open side chat (fork conversation) — alias for /side",
    handler: (_, ctx) => toggleSideChat(ctx),
  });
}

function showOverlapWarning(
  ui: ExtensionUIContext,
  path: string,
): Promise<boolean> {
  return ui.confirm(
    "File Overlap",
    `Main agent has modified:\n  ${path}\n\nEditing may cause conflicts. Proceed?`,
  );
}
