import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type {
  KeyId,
  OverlayHandle,
  Terminal,
  TUI,
} from "@earendil-works/pi-tui";
import {
  buildSessionContext,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { FileActivityTracker } from "./file-activity-tracker.ts";
import { loadConfig } from "./config.ts";
import { getExtensionDir, loadPromptPack } from "./prompt-pack.ts";
import {
  SideChatOverlay,
  SIDE_CHAT_OVERLAY_MARGIN_TOP,
  SIDE_CHAT_OVERLAY_MAX_HEIGHT,
  type ForkContext,
} from "./side-chat-overlay.ts";
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
  return capturedRunner.getAllRegisteredTools().map((rt): AgentTool => {
    const { definition } = rt;
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        definition.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          capturedRunner!.createContext(),
        ),
    };
  });
}

const BACKGROUND_SHORTCUT: KeyId = "alt+q";
const OVERLAY_BLOCKED_ERROR = "PI_SIDE_CHAT_OVERLAY_BLOCKED";

/** Extension directory: base for the bundle config.json and prompt-pack paths. */
const extensionDir = getExtensionDir();

export default function sideChatExtension(pi: ExtensionAPI) {
  const tracker = new FileActivityTracker();
  let activeOverlay: SideChatOverlay | null = null;
  let overlayHandle: OverlayHandle | null = null;
  let lastMessages: AgentMessage[] | null = null;
  let mouseTerminal: Terminal | null = null;
  let removeMouseListener: (() => void) | null = null;

  /**
   * Enable xterm mouse reporting + SGR while the side chat is open and route
   * overlay events (wheel scroll, drag-select, copy) to the chat. Mouse
   * sequences are always consumed so they never leak into the editor as
   * garbage input.
   */
  const installMouseHandler = (tui: TUI) => {
    if (removeMouseListener) return;
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
          event.row >= viewport.topRow &&
          event.row < viewport.topRow + viewport.height;
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
      // garbage input. (In fullscreen mode the alt-screen handler already
      // consumed every SGR sequence before us, so this branch only fires in
      // regular mode.)
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
   * Keep terminal mouse reporting bound to overlay *visibility* (issue #17
   * Q8): backgrounding the chat (hide) must release the terminal's native
   * selection, restoring it on show. Focus is irrelevant — wheel scroll
   * keeps working while visible-but-unfocused.
   */
  const syncMouseReporting = () => {
    if (!removeMouseListener || !mouseTerminal) return;
    if (overlayHandle?.isHidden()) {
      disableMouseReporting(mouseTerminal);
      // Reporting is off, so no release will arrive: abort any in-flight
      // drag so a stale capture cannot swallow later events.
      activeOverlay?.cancelMouseDrag();
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
      // The Alt+/ focus toggle was dropped (Alt+Q owns background/restore):
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
      messages: clear ? [] : (lastMessages ?? sessionContext.messages),
      model: ctx.model,
      systemPrompt: ctx.getSystemPrompt(),
      thinkingLevel: pi.getThinkingLevel(),
      cwd: ctx.cwd,
      extensionTools: getExtensionAgentTools(),
    };

    try {
      const action = await ctx.ui.custom<"close" | "refork" | "clear">(
        (tui, theme, _keybindings, done) => {
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
            sessionManager: ctx.sessionManager,
            promptPack,
            readOnlyExtensionAllowlist: config.readOnlyExtensionAllowlist,
            onOverlapWarning: (path) => showOverlapWarning(ctx.ui, path),
            onBackground: () => {
              overlayHandle?.unfocus();
              overlayHandle?.setHidden(true);
              syncMouseReporting();
            },
            onExport: (path) =>
              ctx.ui.notify(`btw chat exported → ${path}`, "info"),
            onClose: (action, messages) => {
              lastMessages = action === "close" ? messages : null;
              activeOverlay = null;
              overlayHandle = null;
              uninstallMouseHandler();
              done(action);
            },
          });
          installMouseHandler(tui);
          return activeOverlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "85%",
            maxHeight: SIDE_CHAT_OVERLAY_MAX_HEIGHT,
            anchor: "top-center",
            margin: { top: SIDE_CHAT_OVERLAY_MARGIN_TOP, left: 2, right: 2 },
            nonCapturing: true,
          },
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
      uninstallMouseHandler();
      throw error;
    }
  };

  pi.registerShortcut(BACKGROUND_SHORTCUT, {
    description: "Open / background / restore the side chat (keeps it running)",
    handler: backgroundSideChat,
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
