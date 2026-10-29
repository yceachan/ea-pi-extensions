import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  buildSessionContext,
  convertToLlm,
  copyToClipboard,
  createCodingTools,
  createReadOnlyTools,
  getSelectListTheme,
  type ModelRegistry,
  type ScopedModel,
  type KeybindingsManager,
  type AppKeybinding,
  type SessionEntry,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  Editor,
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  type OverlayBounds,
  type TerminalColors,
} from "@earendil-works/pi-tui";
import type { FileActivityTracker } from "./file-activity-tracker.ts";
import { forkSurgery } from "./fork-surgery.ts";
import { exportChatHistoryToFile } from "./side-chat-export.ts";
import {
  isLeftDrag,
  isLeftPress,
  isLeftRelease,
  isWheelEvent,
  type SgrMouseEvent,
  wheelDirection,
} from "./side-chat-mouse.ts";
import { substituteTemplate, type PromptPack } from "./prompt-pack.ts";
import {
  markFramingMessage,
  SideChatMessages,
  type CellPos,
} from "./side-chat-messages.ts";
import { SIDE_CHAT_SHORTCUT } from "./shortcuts.ts";
import { SideChatHelp, actionShortcutLabel, shortcutHint, type ShortcutBindings } from "./side-chat-help.ts";
import { SideChatDialog } from "./side-chat-dialog.ts";
import { paintPanel, PanelPalette } from "./side-chat-panel.ts";
import { renderSideChatInput, type SideChatInputFrame } from "./side-chat-input.ts";
import { sideChatLayoutHeight, type SideChatLayout } from "./side-chat-layout.ts";
import { wrapToolsWithOverlapDetection } from "./tool-wrapper.ts";

export interface ForkContext {
  messages: AgentMessage[];
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  extensionTools: AgentTool[];
}

/** Minimal session view used by the side chat (getEntries + getLeafId). */
type SessionView = { getEntries(): SessionEntry[]; getLeafId(): string | null };

interface SideChatOverlayOptions {
  tui: TUI;
  theme: Theme;
  forkContext: ForkContext;
  tracker: FileActivityTracker;
  modelRegistry: ModelRegistry;
  getScopedModels?: () => readonly ScopedModel[];
  keybindings?: Pick<KeybindingsManager, "matches"> & ShortcutBindings;
  sessionManager: SessionView;
  /** Prompt texts resolved from config.json `promptPack` (fresh per fork). */
  promptPack: PromptPack;
  /** Extension tools allowed in read-only mode (config.json, git-untracked). */
  readOnlyExtensionAllowlist: string[];
  onOverlapWarning: (path: string) => Promise<boolean>;
  onBackground: () => void;
  quiet: boolean;
  onToggleQuiet: () => void;
  onLayoutChange?: (layout: SideChatLayout) => void;
  getBounds?: () => OverlayBounds | undefined;
  onBusyChange?: (busy: boolean) => void;
  onSettingsChange?: (model: Model<any>, thinkingLevel: ThinkingLevel) => void;
  onClose: (action: "close" | "clear") => void;
  /** Alt+E export written to $CWD/.agents/eval/ — called with the written path. */
  onExport: (path: string) => void;
  /** Clipboard boundary; defaults to Pi's native/OSC 52 cascade. */
  copyText?: (text: string) => Promise<void>;
}

/** Normal header: top padding, title + model row, bottom padding, body gap. */
export const SIDE_CHAT_MESSAGE_TOP = 4;
/** Two quick presses within this window (same line) count as a double-click → select line. */
const DOUBLE_CLICK_INTERVAL_MS = 500;
/** Wheel scroll step in lines (matches the previous mouse handler). */
const WHEEL_SCROLL_LINES = 3;
/**
 * Drag-render coalescing: mouse motion events fire per cell moved, and every
 * render redraws the whole frame (main screen + overlay). Capping drag
 * renders to ~30fps keeps the highlight fluid without saturating the event
 * loop on long drags. The selection state still updates on every event;
 * only the paint is throttled, and the release always paints the final look.
 */
const DRAG_RENDER_INTERVAL_MS = 32;
/** Feedback shown after a copy, cleared shortly after. */
const COPIED_STATUS_PREFIX = "✓ Copied ";
const COPIED_STATUS_CLEAR_MS = 1200;

/** Screen geometry of the chat message area (0-based terminal coordinates). */
interface ChatGeometry {
  /** Screen row of the first message line. */
  msgTopRow: number;
  /** Screen column of the first message cell (inside the left border). */
  contentCol: number;
  /** Message area width in cells. */
  innerWidth: number;
  /** Number of visible message lines. */
  msgHeight: number;
}

/**
 * Shared-prefix layout (#9, reverses decision #6): the main lane's system
 * prompt stays in the system slot (verbatim, token-identical request head),
 * and the fork snapshot is injected verbatim below it — main and btw share
 * the gateway's cached prefix. The btw identity/instruction texts live in
 * the prompt pack (framing block message + per-turn focus anchor).
 */

// --- Lane enforcement (prototype for #8, texts from the prompt pack #13) ---
// Trigger points only: transformContext (reminder injection) / beforeToolCall
// (block reason) / afterToolCall (failed-note). UI copy stays in code.

const LANE_BLOCKED_STATUS = "🚧 lane blocked";
const PRE_ABORT_TEXT = "Turn stopped after repeated out-of-lane attempts.";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class SideChatOverlay implements Component, Focusable {
  private agent: Agent;
  private messages: SideChatMessages;
  private editor: Editor;
  private palette = new PanelPalette();
  private unsubscribeColorScheme?: () => void;
  private colorQuery = 0;
  private isStreaming = false;
  private streamingContent = "";
  private toolMode: "full" | "read-only" = "read-only";
  private _focused = true;
  private disposed = false;
  private dialog: SideChatDialog | SideChatHelp | null = null;
  private forkLeafId: string | null;
  private peekMainTool: AgentTool;
  private spinnerInterval: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private lastRenderHeight = 0;
  private lastRenderWidth = 0;
  private layout: SideChatLayout = "floating";
  private messageTop = SIDE_CHAT_MESSAGE_TOP;
  /** Geometry of the last render (screen coords), used for mouse hit-testing. */
  private geometry: ChatGeometry | null = null;
  private editorLayout: SideChatInputFrame["editor"] | null = null;
  /** Mouse drag state: set while a left-button selection drag is in progress. */
  private mouseDragging = false;
  private mouseAnchor: CellPos = { line: 0, col: 0 };
  private lastPressTime = 0;
  private lastPressPos: CellPos | null = null;
  private pendingDoubleClick = false;
  /** The last release ended a drag; a quick follow-up click must not count as a double-click. */
  private lastReleaseWasDrag = false;
  /** Timestamp of the last render triggered by a drag motion event (coalescing). */
  private lastDragRenderAt = 0;
  /** Clears the transient "✓ Copied" status line. */
  private copyClearTimer: NodeJS.Timeout | null = null;
  /** Leading messages injected from the main lane at fork time (context cite). */
  private forkedMessageCount: number;
  /** Tool names allowed in the read-only lane (builtins + allowlist + peek_main). */
  private readOnlyToolNames = new Set<string>();
  /** Out-of-lane attempts in the current turn (reset on each new user message). */
  private laneViolations = 0;
  /** Reminder queued for injection by transformContext before the next LLM call. */
  private pendingReminder: string | null = null;
  /** When true, the turn is aborted right after the escalated reminder is injected. */
  private abortAfterInject = false;

  /**
   * Screen rectangle occupied by the overlay (0-based), used to route mouse
   * wheel events to the chat. Returns null when the overlay is gone.
   */
  getViewport(): { topRow: number; leftCol: number; width: number; height: number } | null {
    if (this.disposed) return null;
    // Bounds are authoritative after Pi has placed the current frame. Do not
    // query them in render(): that would return the previous layout's bounds.
    const bounds = this.options.getBounds?.();
    if (bounds) return { topRow: bounds.row, leftCol: bounds.col, width: bounds.width, height: bounds.height };
    return {
      ...this.getFallbackViewport(),
      width: this.lastRenderWidth,
      height: this.lastRenderHeight,
    };
  }

  /** Scroll the message area (positive = toward older content). Mouse wheel handler. */
  scrollByLines(lines: number): boolean {
    const changed = this.messages.scrollBy(lines);
    if (changed) this.options.tui.requestRender();
    return changed;
  }

  /** True while a left-button drag is captured (events stay consumed even off-overlay). */
  isMouseDragging(): boolean {
    return this.mouseDragging;
  }

  /**
   * Abort an in-flight drag without waiting for the release (used when the
   * overlay is hidden mid-drag).
   */
  cancelMouseDrag(): void {
    this.mouseDragging = false;
    this.pendingDoubleClick = false;
    this.lastPressPos = null;
    this.messages.clearSelection();
  }

  /** Fullscreen entry point: Pi supplies overlay-local coordinates and owns capture. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return { handled: true, render: false };
    if (this.dialog) {
      if (this.dialog instanceof SideChatHelp && event.type === "wheel") {
        this.dialog.scrollBy(event.wheelDelta ?? 0);
        return { handled: true, render: true };
      }
      return { handled: true, render: false, focus: event.type === "press" };
    }
    // Use the dispatched rectangle, not a guessed percentage/terminal origin.
    // Captured drag coordinates can lie outside this rectangle.
    if (this.geometry) {
      this.geometry = {
        ...this.geometry,
        msgTopRow: event.screenY - event.y + this.messageTop,
        contentCol: event.screenX - event.x + 2,
        innerWidth: Math.max(0, event.width - 4),
        msgHeight: Math.max(0, Math.min(this.geometry.msgHeight, event.height - this.messageTop)),
      };
    }
    if (event.type === "wheel") {
      this.scrollByLines(-(event.wheelDelta ?? 0));
      return { handled: true, render: false };
    }
    const editor = this.editorLayout;
    if (
      !this.mouseDragging && editor && event.y >= editor.top &&
      event.y < editor.top + editor.height && event.x >= editor.left &&
      event.x < editor.left + editor.width
    ) {
      if (event.type === "press") this.cancelMouseDrag();
      const result = this.editor.handleMouse?.({
        ...event,
        x: event.x - editor.left,
        y: event.y - editor.top + editor.sourceOffset,
        width: editor.width,
        height: editor.sourceHeight,
      });
      // Keep keyboard focus on the overlay so its shortcuts still work.
      return result ?? { handled: true, render: false };
    }
    // Consume frame clicks as well: Pi's transcript selection must not select
    // the main conversation hidden beneath the overlay.
    const primaryGesture = event.button === "left" ||
      (event.type === "release" && this.mouseDragging);
    if (
      !primaryGesture ||
      ((event.shift || event.alt || event.ctrl) && !this.mouseDragging) ||
      event.type === "click" || event.type === "move"
    ) {
      return { handled: true, render: false };
    }
    this.handleMouseEvent({
      button: event.type === "drag" ? 32 : 0,
      col: event.screenX + 1,
      row: event.screenY + 1,
      isRelease: event.type === "release",
    }, false);
    return {
      handled: true,
      capture: this.mouseDragging,
      focus: event.type === "press",
      // The shared handler coalesces drag rendering and paints releases.
      render: false,
    };
  }

  /**
   * Handle an SGR mouse event located over the overlay. Screen coordinates
   * are 1-based (as reported by the terminal); the chat area is hit-tested
   * against the geometry of the last render.
   */
  handleMouseEvent(event: SgrMouseEvent, syncBounds = true): void {
    if (this.disposed) return;
    if (syncBounds && this.geometry) {
      const viewport = this.getViewport();
      if (viewport) {
        this.geometry.msgTopRow = viewport.topRow + this.messageTop;
        this.geometry.contentCol = viewport.leftCol + 2;
      }
    }
    if (this.dialog) {
      if (this.dialog instanceof SideChatHelp && isWheelEvent(event)) {
        this.dialog.scrollBy(-wheelDirection(event) * WHEEL_SCROLL_LINES);
        this.options.tui.requestRender();
      }
      return;
    }
    if (isWheelEvent(event)) {
      this.scrollByLines(wheelDirection(event) * WHEEL_SCROLL_LINES);
      return;
    }
    if (isLeftPress(event)) {
      const pos = this.screenToChat(event.row - 1, event.col - 1);
      if (!pos) {
        this.cancelMouseDrag();
        this.options.tui.requestRender();
        return;
      }
      const now = Date.now();
      const doubleClick =
        this.lastPressPos !== null &&
        !this.lastReleaseWasDrag &&
        now - this.lastPressTime <= DOUBLE_CLICK_INTERVAL_MS &&
        Math.abs(pos.line - this.lastPressPos.line) <= 1 &&
        Math.abs(pos.col - this.lastPressPos.col) <= 2;
      this.mouseDragging = true;
      this.mouseAnchor = pos;
      this.lastPressPos = pos;
      this.lastPressTime = now;
      this.pendingDoubleClick = doubleClick;
      // Seed the selection with the anchor (empty range): the window-shift
      // translation in render() then keeps the anchor aligned with the same
      // content when status/stream lines are appended mid-drag.
      this.messages.setSelection(pos, pos);
      this.options.tui.requestRender();
      return;
    }
    if (isLeftDrag(event)) {
      if (!this.mouseDragging) return;
      const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
      const anchor = this.messages.getSelectionAnchor() ?? this.mouseAnchor;
      this.messages.setSelection(anchor, pos);
      // Coalesce drag paints: the selection state is always current (the next
      // render picks it up), only the number of full-frame redraws is capped.
      const now = Date.now();
      if (now - this.lastDragRenderAt >= DRAG_RENDER_INTERVAL_MS) {
        this.lastDragRenderAt = now;
        this.options.tui.requestRender();
      }
      return;
    }
    if (isLeftRelease(event)) {
      if (!this.mouseDragging) return;
      this.mouseDragging = false;
      this.lastReleaseWasDrag = true;
      if (this.pendingDoubleClick) {
        // Double-click: select the whole rendered line (no auto-copy; the
        // hotkey copies it).
        this.pendingDoubleClick = false;
        this.lastReleaseWasDrag = false;
        const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
        this.messages.setSelection(
          { line: pos.line, col: 0 },
          { line: pos.line, col: this.geometry?.innerWidth ?? 0 },
        );
        this.options.tui.requestRender();
        return;
      }
      this.pendingDoubleClick = false;
      const pos = this.clampScreenToChat(event.row - 1, event.col - 1);
      if (this.messages.hasSelection()) {
        // Drag-release: finalize the selection (the anchor may have been
        // window-shifted by appended status/stream lines mid-drag). The
        // selection stays highlighted so Ctrl+C copies it (hotkey-only copy).
        const anchor = this.messages.getSelectionAnchor() ?? this.mouseAnchor;
        this.messages.setSelection(anchor, pos);
      } else {
        // Plain click without drag: no selection.
        this.messages.clearSelection();
        this.lastReleaseWasDrag = false;
      }
      this.options.tui.requestRender();
    }
  }

  /**
   * Copy the current mouse selection to the clipboard (native → wl-copy /
   * xclip → OSC 52 cascade via {@link copyToClipboard}, matching the main
   * app's tree selector) and show a transient status. Copying is hotkey-only:
   * `Ctrl+C` / `Ctrl+Shift+C` with an active mouse selection. The selection
   * stays highlighted so a second copy key press re-copies. Returns false when
   * there is nothing to copy.
   */
  async copySelectionToClipboard(): Promise<boolean> {
    const text = this.messages.getSelectedText();
    if (!text) return false;
    try {
      await (this.options.copyText ?? copyToClipboard)(text);
    } catch (error) {
      this.messages.setErrorContent(
        `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.options.tui.requestRender();
      return false;
    }
    const status = `${COPIED_STATUS_PREFIX}${Array.from(text).length} chars`;
    this.messages.setToolStatus(status);
    this.options.tui.requestRender();
    if (this.copyClearTimer) clearTimeout(this.copyClearTimer);
    this.copyClearTimer = setTimeout(() => {
      this.messages.clearToolStatusIf(status);
      this.options.tui.requestRender();
    }, COPIED_STATUS_CLEAR_MS);
    return true;
  }

  /** Map 0-based screen coords to a chat cell position, or null off the chat area. */
  private screenToChat(row: number, col: number): CellPos | null {
    const g = this.geometry;
    if (!g || g.msgHeight <= 0 || g.innerWidth <= 0) return null;
    const line = row - g.msgTopRow;
    const c = col - g.contentCol;
    if (line < 0 || line >= g.msgHeight || c < 0 || c >= g.innerWidth)
      return null;
    return { line, col: c };
  }

  /** Like {@link screenToChat} but clamps into the chat area (drag overshoot). */
  private clampScreenToChat(row: number, col: number): CellPos {
    const g = this.geometry;
    if (!g) return { line: 0, col: 0 };
    const line = Math.max(0, Math.min(row - g.msgTopRow, g.msgHeight - 1));
    const c = Math.max(0, Math.min(col - g.contentCol, g.innerWidth));
    return { line, col: c };
  }

  get focused() {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.editor.focused = v;
  }

  constructor(private options: SideChatOverlayOptions) {
    const {
      tui,
      theme,
      forkContext,
      modelRegistry,
      sessionManager,
      promptPack,
    } = options;
    // Fork surgery (#12): make the trailing tool exchange gateway-legal on a
    // clone of the fork snapshot (synthesize missing results, drop orphans).
    const forkedMessages = forkSurgery(structuredClone(forkContext.messages));

    this.forkLeafId = sessionManager.getLeafId();
    this.forkedMessageCount = forkedMessages.length;
    this.peekMainTool = this.createPeekMainTool(sessionManager);
    // Strip philosophy (#7): read-only lane = builtins + allowlisted extension
    // tools + peek_main. Everything else is absent from the list → attempts
    // surface as "Tool X not found" errors (the detection signal).
    this.readOnlyToolNames = new Set(
      this.buildReadOnlyTools().map((t) => t.name),
    );

    // Framing block (#9): between the cite and the user's first btw message.
    // User-role fallback placement (#11) — the request path keeps only
    // user/assistant/toolResult roles (convertToLlm + openai-completions
    // buildRequest), so trailing-system placement is not reachable through
    // the standard pipeline (ADR-0001 prototype implementation note). The
    // message is marked so the render path never shows it as a chat bubble.
    const framingMessage = markFramingMessage({
      role: "user",
      content: substituteTemplate(promptPack.framing, {
        cwd: forkContext.cwd,
        model: forkContext.model.id,
      }),
      timestamp: Date.now(),
    });

    this.agent = new Agent({
      // Registry streaming supports configured credentials, headers and virtual
      // models; the global compatibility streamer cannot resolve virtual models.
      streamFn: (model, context, options) => modelRegistry.streamSimple(model, context, options),
      initialState: {
        // Shared-prefix layout (#9): the MAIN persona stays in the system
        // slot so the request head matches the main lane token-for-token.
        systemPrompt: forkContext.systemPrompt,
        model: forkContext.model,
        thinkingLevel: forkContext.thinkingLevel,
        tools: this.buildReadOnlyTools(),
        messages: [...forkedMessages, framingMessage],
      },
      convertToLlm,
      // Transient tail injections (present in the LLM request only, never
      // stored in the transcript), texts from the prompt pack:
      // - focus anchor: every turn, both modes (recency position);
      // - lane preamble: read-only lane only (full mode stays untouched);
      // - pending lane reminder: after an out-of-lane attempt; escalated
      //   violations abort the turn right after the reminder is queued.
      transformContext: async (messages) => {
        const additions: AgentMessage[] = [
          {
            role: "user",
            content: promptPack.focusAnchor,
            timestamp: Date.now(),
          },
        ];
        if (this.toolMode === "read-only") {
          additions.push({
            role: "user",
            content: promptPack.laneReminders.preamble,
            timestamp: Date.now(),
          });
        }
        if (this.pendingReminder) {
          const reminder = this.pendingReminder;
          this.pendingReminder = null;
          if (this.abortAfterInject) {
            this.abortAfterInject = false;
            this.messages.setErrorContent(PRE_ABORT_TEXT);
            setTimeout(() => this.agent.abort(), 0);
          }
          additions.push({
            role: "user",
            content: reminder,
            timestamp: Date.now(),
          });
        }
        return [...messages, ...additions];
      },
      // Belt-and-braces: block any residual present-but-disallowed tool with
      // the base reminder as the reason (blocked calls never reach afterToolCall).
      beforeToolCall: async (ctx) => {
        if (this.toolMode !== "read-only") return undefined;
        if (this.readOnlyToolNames.has(ctx.toolCall.name)) return undefined;
        return {
          block: true,
          reason: substituteTemplate(promptPack.laneReminders.base, {
            tool: ctx.toolCall.name,
          }),
        };
      },
      // Layer 2: re-ground executed-but-failed read-only calls (never fires
      // for blocked/absent tools). Not a violation — no escalation count.
      afterToolCall: async (ctx) => {
        if (this.toolMode !== "read-only" || !ctx.isError) return undefined;
        const content = [...ctx.result.content];
        if (!content.some((c) => c.type === "text" && c.text.includes("🚧"))) {
          content.push({
            type: "text",
            text: promptPack.laneReminders.failedNote,
          });
        }
        return { content };
      },
    });

    this.agent.subscribe((e) => this.handleAgentEvent(e));
    this.messages = new SideChatMessages(theme, 20, this.palette);
    this.messages.setQuiet(options.quiet);
    // The whole forked batch (main-session context or reopened history) is
    // injected at open time: render it as one collapsed cite line, not as
    // full history. New messages appended after the fork render normally.
    // The framing block message is marked and skipped by the render path.
    this.messages.setInjectedMessageCount(forkedMessages.length);
    this.messages.setMessages(forkedMessages);
    this.editor = new Editor(
      tui,
      {
        borderColor: (t) => theme.fg("borderMuted", t),
        selectList: getSelectListTheme(),
      },
      { paddingX: 0 },
    );
    this.editor.onSubmit = (text) => this.handleSubmit(text);
    this.unsubscribeColorScheme = tui.onTerminalColorSchemeChange?.(() => this.queryPanelColors());
    this.queryPanelColors();
  }

  private queryPanelColors(): void {
    const tui = this.options.tui;
    if (!tui.queryTerminalColors) return;
    const generation = ++this.colorQuery;
    const apply = (colors: TerminalColors) => {
      if (this.disposed || generation !== this.colorQuery) return;
      this.palette.setTerminalColors(colors);
      this.invalidate();
      tui.requestRender();
    };
    void tui.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply).catch(() => {});
  }

  private createPeekMainTool(sessionManager: SessionView): AgentTool {
    return {
      name: "peek_main",
      label: "peek_main",
      description:
        "View main agent's recent activity. Use when user asks about main's progress or status.",
      parameters: Type.Object({
        lines: Type.Optional(
          Type.Integer({
            description: "Max items (default: 20)",
            minimum: 1,
            maximum: 50,
          }),
        ),
        since_fork: Type.Optional(
          Type.Boolean({
            description: "Only show activity after side chat opened",
          }),
        ),
      }),
      execute: async (_id, params) => {
        const args = (params ?? {}) as { lines?: number; since_fork?: boolean };
        const entries = sessionManager.getEntries();
        const context = buildSessionContext(
          entries,
          sessionManager.getLeafId(),
        );
        let msgs = context.messages;

        if (args.since_fork && this.forkLeafId) {
          const forkCtx = buildSessionContext(entries, this.forkLeafId);
          msgs = msgs.slice(forkCtx.messages.length);
        }

        const recent = msgs.slice(-(args.lines ?? 20));
        if (!recent.length) {
          return {
            content: [
              {
                type: "text",
                text: args.since_fork
                  ? "No new activity since fork."
                  : "No recent activity.",
              },
            ],
            details: undefined,
          };
        }

        const formatted = recent
          .map((m) => this.formatMessage(m))
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [
            {
              type: "text",
              text: `Main agent activity (${recent.length} items):\n\n${formatted}`,
            },
          ],
          details: undefined,
        };
      },
    };
  }

  /**
   * Read-only lane tool list (strip philosophy, #7): builtin read tools +
   * allowlisted extension tools (config.json `readOnlyExtensionAllowlist`,
   * git-untracked) + peek_main. Everything else is stripped from the list.
   */
  private buildReadOnlyTools(): AgentTool[] {
    const { forkContext } = this.options;
    const allowlisted = forkContext.extensionTools.filter((t) =>
      this.options.readOnlyExtensionAllowlist.includes(t.name),
    );
    return [
      ...createReadOnlyTools(forkContext.cwd),
      ...allowlisted,
      this.peekMainTool,
    ];
  }

  /**
   * 1st violation → base reminder; 2nd → escalated wording + turn abort.
   * Texts come from the prompt pack (#13); the reminder is injected by
   * transformContext before the next LLM call.
   */
  private registerLaneViolation(toolName: string) {
    this.laneViolations += 1;
    // Stop the spinner first: the lane-blocked status would otherwise be
    // overwritten by the 80ms spinner tick.
    this.stopSpinner();
    if (this.laneViolations === 1) {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.base,
        { tool: toolName },
      );
      this.messages.setToolStatus(LANE_BLOCKED_STATUS);
    } else {
      this.pendingReminder = substituteTemplate(
        this.options.promptPack.laneReminders.escalated,
        {
          tool: toolName,
          count: this.laneViolations,
        },
      );
      this.abortAfterInject = true;
      this.messages.setToolStatus(`${LANE_BLOCKED_STATUS} — escalating`);
    }
    this.options.tui.requestRender();
  }

  private formatMessage(msg: AgentMessage): string {
    if (msg.role === "user") {
      const c =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((b) => (b.type === "text" ? b.text : "[image]"))
              .join("");
      return `[User]: ${c.slice(0, 300)}${c.length > 300 ? "..." : ""}`;
    }
    if (msg.role === "assistant") {
      const fullText = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const text = fullText.slice(0, 500);
      const tools = msg.content
        .filter((b) => b.type === "toolCall")
        .map((t) => t.name);
      const parts = [
        text && text + (fullText.length > 500 ? "..." : ""),
        tools.length && `[Calling: ${tools.join(", ")}]`,
      ].filter(Boolean);
      return parts.length ? `[Assistant]: ${parts.join("\n")}` : "";
    }
    if (msg.role === "toolResult") {
      const fullText =
        msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const preview = fullText.slice(0, 150);
      return `[${msg.toolName}]: ${preview}${fullText.length > 150 ? "..." : ""}`;
    }
    return "";
  }

  private startSpinner() {
    this.stopSpinner();
    this.spinnerFrame = 0;
    this.messages.setToolStatus(`${SPINNER[0]} Working...`);
    this.options.tui.requestRender();
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
      this.messages.setToolStatus(`${SPINNER[this.spinnerFrame]} Working...`);
      this.options.tui.requestRender();
    }, 80);
  }

  private stopSpinner() {
    if (!this.spinnerInterval) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = null;
    this.messages.setToolStatus("");
  }

  setQuiet(quiet: boolean): void {
    this.options.quiet = quiet;
    this.cancelMouseDrag();
    this.messages.setQuiet(quiet);
    this.options.tui.requestRender();
  }

  private async handleSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.disposed) return;
    if (trimmed === "/btw-quiet") {
      this.editor.setText("");
      this.options.onToggleQuiet();
      return;
    }
    if (this.isStreaming) return;

    // New user message: reset the per-turn lane counter.
    this.laneViolations = 0;
    this.pendingReminder = null;
    this.abortAfterInject = false;

    this.editor.setText("");
    this.isStreaming = true;
    this.options.onBusyChange?.(true);
    this.streamingContent = "";
    // A new user message resumes bottom-following even if the view was frozen.
    this.messages.resumeFollowing();
    this.messages.setStreamingContent("");
    this.messages.setErrorContent("");
    this.startSpinner();

    try {
      await this.agent.prompt(trimmed);
    } catch (e) {
      this.streamingContent = "";
      if (!this.disposed) {
        this.messages.setErrorContent(
          e instanceof Error ? e.message : "Unknown error",
        );
      }
    } finally {
      this.isStreaming = false;
      if (!this.disposed) this.options.onBusyChange?.(false);
      this.streamingContent = "";
      this.stopSpinner();
      this.messages.setStreamingContent("");
      this.messages.setToolStatus("");
      this.messages.setMessages([...this.agent.state.messages]);
      if (!this.disposed) this.options.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    if (this.disposed) return;

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      this.stopSpinner();
      this.streamingContent += event.assistantMessageEvent.delta;
      if (event.message.role === "assistant") this.messages.setStreamingMessage(event.message);
    } else if (event.type === "message_update") {
      // Thinking-only updates and mixed thinking/text blocks use the same
      // renderer as completed responses, not a separate plain-text preview.
      if (event.message.role === "assistant") this.messages.setStreamingMessage(event.message);
    } else if (event.type === "message_end") {
      this.messages.setMessages([...this.agent.state.messages]);
      this.messages.setStreamingContent("");
      this.streamingContent = "";
    } else if (event.type === "tool_execution_start") {
      this.stopSpinner();
      this.messages.setToolStatus(`Running ${event.toolName}...`);
    } else if (event.type === "tool_execution_end") {
      this.startSpinner();
      // Detection signal: an error result for a tool that is not in the
      // read-only lane (absent tools produce "Tool X not found" errors).
      if (
        this.toolMode === "read-only" &&
        event.isError &&
        !this.readOnlyToolNames.has(event.toolName)
      ) {
        this.registerLaneViolation(event.toolName);
      }
    }

    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    this.lastRenderWidth = width;
    if (width < 4) {
      this.geometry = null;
      this.editorLayout = null;
      this.lastRenderHeight = 1;
      this.cancelMouseDrag();
      return [" ".repeat(Math.max(0, width))];
    }

    const { theme, tracker } = this.options;
    const height = sideChatLayoutHeight(this.options.tui.terminal.rows, this.layout);
    if (this.dialog) {
      this.geometry = null;
      this.editorLayout = null;
      this.cancelMouseDrag();
      const lines = this.dialog.render(width, this.dialog instanceof SideChatHelp ? height : Math.min(height, 18), theme, this.palette);
      this.lastRenderHeight = lines.length;
      return lines;
    }
    const innerWidth = width - 4;

    const title = "Side Chat";
    const mainLabel = tracker.writeCount
      ? `${tracker.writeCount} file${tracker.writeCount > 1 ? "s" : ""}`
      : "idle";
    const modeLabel = this.toolMode === "full" ? "Edit" : "Read-only";
    const modeColor: ThemeColor = this.toolMode === "full" ? "warning" : "dim";
    const scrollMark = this.messages.isAtBottom()
      ? ""
      : theme.fg("warning", ` [↑${this.messages.getScrollOffset()}]`);
    const status =
      theme.fg("dim", `[Main: ${mainLabel}] `) +
      theme.fg(modeColor, `[${modeLabel}]`) +
      (this.options.quiet ? theme.fg("dim", " [Quiet]") : "") +
      scrollMark;
    const stream = theme.fg(this.isStreaming ? "warning" : "success", " ●");
    const model = this.agent.state.model;
    const left = theme.fg("accent", title) + stream;
    const modelDetails = theme.fg("muted", `${model?.provider ?? ""}/${model?.id ?? "no-model"}  ·  ${this.agent.state.thinkingLevel}`);
    const compact = height < 18;
    const minimal = height < 8;
    this.messageTop = minimal ? 0 : compact ? 2 : SIDE_CHAT_MESSAGE_TOP;
    const hintLines = minimal ? [] : buildSideChatHintLines(innerWidth, this.options.keybindings, theme);
    const bottomPadding = compact ? 0 : 1;
    const inputBudget = Math.max(1, Math.min(7, Math.floor(height / 3) + 2,
      height - this.messageTop - hintLines.length - bottomPadding - 1));
    const input = renderSideChatInput(this.editor, theme, width, inputBudget, this.palette);
    // Budget the card's actual height; an empty draft occupies only three rows.
    const chrome = this.messageTop + input.lines.length + hintLines.length + bottomPadding;
    const maxLines = Math.max(0, height - chrome);
    this.messages.setMaxVisibleLines(maxLines);
    const msgLines = maxLines > 0 ? this.messages.render(innerWidth) : [];
    for (let i = msgLines.length; i < maxLines; i++) msgLines.push("");

    this.editorLayout = { ...input.editor, top: this.messageTop + msgLines.length + input.editor.top };
    const lines = renderSideChatFrame({
      width,
      theme,
      headerLeft: left,
      headerRight: status,
      modelDetails,
      palette: this.palette,
      compact,
      minimal,
      msgLines,
      inputLines: input.lines,
      hints: hintLines,
    });
    const frame = lines.slice(0, height);
    this.lastRenderHeight = frame.length;
    const viewport = this.getFallbackViewport();
    this.geometry = {
      msgTopRow: viewport.topRow + this.messageTop,
      contentCol: viewport.leftCol + 2,
      innerWidth,
      msgHeight: msgLines.length,
    };
    return frame;
  }

  private getFallbackViewport() {
    const { columns, rows } = this.options.tui.terminal;
    return {
      topRow: this.layout === "floating" ? Math.max(0, Math.floor((rows - this.lastRenderHeight) / 2))
        : this.layout === "compact" ? Math.max(0, Math.min(1, rows - this.lastRenderHeight)) : 0,
      leftCol: this.layout === "floating" || this.layout === "compact" ? Math.floor((columns - this.lastRenderWidth) / 2)
        : this.layout === "right" ? columns - this.lastRenderWidth : 0,
    };
  }

  private changeLayout(layout: SideChatLayout): void {
    this.cancelMouseDrag();
    this.layout = layout;
    this.geometry = null;
    this.editorLayout = null;
    this.options.onLayoutChange?.(layout);
    this.invalidate();
    this.options.tui.requestRender();
  }

  private openDialog(dialog: SideChatDialog | SideChatHelp): void {
    this.cancelMouseDrag();
    this.dialog = dialog;
    this.editor.focused = false;
    this.options.tui.requestRender();
  }

  private dismissDialog(): void {
    this.dialog = null;
    this.editor.focused = this.focused;
    this.options.tui.requestRender();
  }

  private chooseModel(): void {
    if (this.isStreaming) {
      this.messages.setToolStatus("Stop the current turn with Alt+S before changing models.");
      this.options.tui.requestRender();
      return;
    }
    const models = this.options.modelRegistry.getAvailable();
    const current = this.agent.state.model;
    this.openDialog(new SideChatDialog(
      this.options.theme, "Side-chat model (main model is unchanged)",
      models.map((model, i) => ({ value: String(i), label: `${model.provider}/${model.id}`, description: model.name })),
      true,
      models.findIndex((model) => model.id === current?.id && model.provider === current?.provider),
      (value) => {
        const model = models[Number(value)];
        if (!model) return;
        this.agent.state.model = model;
        this.agent.state.thinkingLevel = clampThinkingLevel(model, this.agent.state.thinkingLevel);
        this.options.onSettingsChange?.(model, this.agent.state.thinkingLevel);
        this.dismissDialog();
      },
      () => this.dismissDialog(),
      models.length ? "Type to filter available models." : "No authenticated models available. Configure a provider in Pi first.",
    ));
  }

  private chooseThinking(): void {
    if (this.isStreaming) {
      this.messages.setToolStatus("Stop the current turn with Alt+S before changing thinking level.");
      this.options.tui.requestRender();
      return;
    }
    const model = this.agent.state.model;
    if (!model) return;
    const levels = getSupportedThinkingLevels(model);
    this.openDialog(new SideChatDialog(
      this.options.theme, "Side-chat thinking level (main is unchanged)",
      levels.map((level) => ({ value: level, label: level })),
      false, levels.indexOf(this.agent.state.thinkingLevel),
      (value) => {
        this.agent.state.thinkingLevel = value as ThinkingLevel;
        this.options.onSettingsChange?.(model, this.agent.state.thinkingLevel);
        this.dismissDialog();
      },
      () => this.dismissDialog(),
      model.reasoning ? "Choose a level supported by the side-chat model." : "This model does not support reasoning; only off is available.",
    ));
  }

  private matchesAction(data: string, action: AppKeybinding, fallback: Parameters<typeof matchesKey>[1]): boolean {
    return this.options.keybindings?.matches?.(data, action) ?? matchesKey(data, fallback);
  }

  private canChangeSettings(): boolean {
    if (!this.isStreaming) return true;
    this.messages.setToolStatus("Stop the current turn with Alt+S before changing model/thinking settings.");
    this.options.tui.requestRender();
    return false;
  }

  private cycleModel(direction: 1 | -1): void {
    if (!this.canChangeSettings()) return;
    const available = this.options.modelRegistry.getAvailable();
    const scoped = this.options.getScopedModels?.() ?? [];
    const candidates = scoped.length
      ? scoped.filter(({ model }) => available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id))
      : available.map((model) => ({ model, thinkingLevel: undefined }));
    if (candidates.length <= 1) return;
    const current = this.agent.state.model;
    const index = Math.max(0, candidates.findIndex(({ model }) => model.provider === current?.provider && model.id === current?.id));
    const next = candidates[(index + direction + candidates.length) % candidates.length]!;
    this.agent.state.model = next.model;
    this.agent.state.thinkingLevel = clampThinkingLevel(next.model, next.thinkingLevel ?? this.agent.state.thinkingLevel);
    this.options.onSettingsChange?.(next.model, this.agent.state.thinkingLevel);
    this.options.tui.requestRender();
  }

  private cycleThinking(): void {
    if (!this.canChangeSettings()) return;
    const model = this.agent.state.model;
    if (!model) return;
    const levels = getSupportedThinkingLevels(model);
    const index = levels.indexOf(this.agent.state.thinkingLevel);
    this.agent.state.thinkingLevel = levels[(index + 1) % levels.length]!;
    this.options.onSettingsChange?.(model, this.agent.state.thinkingLevel);
    this.options.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, SIDE_CHAT_SHORTCUT)) {
      this.options.onBackground();
      return;
    }
    // Layout shortcuts work in pickers/help too, without replacing the agent.
    if (matchesKey(data, Key.ctrlAlt("left"))) { this.changeLayout("fullscreen"); return; }
    if (matchesKey(data, Key.ctrlAlt("up"))) { this.changeLayout("compact"); return; }
    if (matchesKey(data, Key.ctrlAlt("right"))) { this.changeLayout("right"); return; }
    if (matchesKey(data, Key.ctrlAlt("down"))) { this.changeLayout("floating"); return; }
    // Stopping a turn must remain available inside help and model pickers too.
    if (matchesKey(data, Key.alt("s"))) { this.agent.abort(); return; }
    if (this.dialog) {
      this.dialog.handleInput(data);
      this.options.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.isStreaming) this.agent.abort();
      else this.options.onBackground();
      return;
    }
    if (matchesKey(data, Key.alt("n"))) {
      this.dispose("clear");
      return;
    }
    // Only an empty draft treats ? as navigation; normal questions and pasted text stay editable.
    if (data === "?" && !this.editor.getText()) {
      this.openDialog(new SideChatHelp(() => this.dismissDialog(), this.options.keybindings));
      return;
    }
    if (this.matchesAction(data, "app.model.cycleForward", Key.ctrl("p"))) { this.cycleModel(1); return; }
    if (this.matchesAction(data, "app.model.cycleBackward", Key.ctrlShift("p")) || matchesKey(data, Key.alt("p"))) { this.cycleModel(-1); return; }
    if (this.matchesAction(data, "app.thinking.cycle", Key.shift("tab"))) { this.cycleThinking(); return; }
    if (matchesKey(data, Key.alt("m"))) { this.chooseModel(); return; }
    if (matchesKey(data, Key.alt("t"))) { this.chooseThinking(); return; }
    if (matchesKey(data, Key.alt("e"))) {
      this.exportChatHistory();
      return;
    }
    if (
      matchesKey(data, Key.ctrl("c")) ||
      matchesKey(data, Key.ctrlShift("c"))
    ) {
      // Hotkey copy: with an active mouse selection, Ctrl+C / Ctrl+Shift+C
      // copies it. Without one, fall through so Ctrl+C keeps the editor's
      // own semantics.
      if (this.messages.hasSelection()) {
        void this.copySelectionToClipboard();
        return;
      }
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.toolMode = this.toolMode === "full" ? "read-only" : "full";
      // Read-only lane keeps the strip philosophy; edit mode stays untouched
      // (enforcement out of scope until the crash bug is understood, #4).
      const { forkContext, tracker, onOverlapWarning } = this.options;
      this.agent.state.tools =
        this.toolMode === "read-only"
          ? this.buildReadOnlyTools()
          : [
              ...wrapToolsWithOverlapDetection(
                createCodingTools(forkContext.cwd),
                tracker,
                forkContext.cwd,
                onOverlapWarning,
              ),
              ...forkContext.extensionTools,
              this.peekMainTool,
            ];
      this.options.tui.requestRender();
      return;
    }
    const tuiBindings = getKeybindings();
    if (tuiBindings.matches(data, "tui.altScreen.previousPrompt") ||
        tuiBindings.matches(data, "tui.altScreen.nextPrompt")) {
      const direction = tuiBindings.matches(data, "tui.altScreen.previousPrompt") ? -1 : 1;
      this.cancelMouseDrag();
      this.messages.jumpToMessage(direction);
      this.options.tui.requestRender();
      return;
    }
    if (this.messages.handleInput(data)) {
      this.options.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  /**
   * Alt+E: export the btw transcript to `$CWD/.agents/eval/pi-better-btw-<ts>.md`
   * as a markdown diagnostic artifact (feature/debug work). The snapshot is
   * taken from the agent state at the moment of the keypress.
   */
  private exportChatHistory() {
    try {
      const path = exportChatHistoryToFile({
        messages: [...this.agent.state.messages],
        streamingContent: this.streamingContent,
        cwd: this.options.forkContext.cwd,
        modelId: this.agent.state.model?.id ?? this.options.forkContext.model.id,
        toolMode: this.toolMode,
        forkedMessageCount: this.forkedMessageCount,
        streaming: this.isStreaming,
      });
      // Status line feedback inside the overlay + a toast in the main session.
      this.stopSpinner();
      this.messages.setToolStatus(`✓ exported → ${path}`);
      this.options.onExport(path);
    } catch (error) {
      this.messages.setErrorContent(
        `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.options.tui.requestRender();
  }

  dispose(action: "close" | "clear" = "close") {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeColorScheme?.();
    this.unsubscribeColorScheme = undefined;
    this.dialog = null;
    this.stopSpinner();
    if (this.copyClearTimer) {
      clearTimeout(this.copyClearTimer);
      this.copyClearTimer = null;
    }
    this.agent.abort();
    this.options.onClose(action);
  }

  invalidate() {
    this.messages.invalidate();
    this.editor.invalidate();
  }
}

/**
 * Pure, borderless panel renderer: header, messages, editor and hints.
 * Kept separate so previews/tests can render the exact same frame without a TUI.
 */
export interface SideChatFrameOptions {
  width: number;
  theme: Theme;
  headerLeft: string;
  headerRight: string;
  modelDetails?: string;
  palette?: PanelPalette;
  compact?: boolean;
  minimal?: boolean;
  msgLines: string[];
  inputLines: string[];
  hints: string[];
}

export function renderSideChatFrame(opts: SideChatFrameOptions): string[] {
  const { theme, width } = opts;
  const innerWidth = width - 4;
  const lines: string[] = [];

  // Reserve title + a useful model preview before spending space on status.
  const leftText = opts.headerLeft + (opts.modelDetails ? `  ${opts.modelDetails}` : "");
  const minLeft = Math.min(innerWidth, visibleWidth(opts.headerLeft) + (opts.modelDetails ? 18 : 0));
  const headerRight = truncateToWidth(opts.headerRight, Math.max(0, innerWidth - minLeft - 2));
  const headerLeft = truncateToWidth(leftText, Math.max(0, innerWidth - visibleWidth(headerRight) - 2));
  const headerGap = " ".repeat(Math.max(0, innerWidth - visibleWidth(headerLeft) - visibleWidth(headerRight)));

  const row = (surface: "body" | "header" | "input", text = "") =>
    paintPanel(theme, surface, `  ${truncateToWidth(text, Math.max(0, innerWidth), "…", true)}  `, width, opts.palette);
  if (!opts.minimal) {
    if (!opts.compact) lines.push(row("header"));
    lines.push(row("header", `${headerLeft}${headerGap}${headerRight}`));
    if (!opts.compact) lines.push(row("header"));
    lines.push(row("body"));
  }
  // Message rows already own their background. Paint only the frame margins;
  // a second body wrapper would steal user-card colors after ANSI resets.
  const margin = paintPanel(theme, "body", "", 2, opts.palette);
  for (const line of opts.msgLines) lines.push(margin + (line || paintPanel(theme, "body", "", Math.max(0, innerWidth), opts.palette)) + margin);
  lines.push(...opts.inputLines);
  for (const line of opts.hints) lines.push(row("header", line));
  if (!opts.compact) lines.push(row("header"));

  return lines.map((l) =>
    visibleWidth(l) > width ? truncateToWidth(l, width) : l,
  );
}

/** One quiet row outside the input card; drop secondary actions before clipping keys. */
export function buildSideChatHintLines(width: number, bindings?: ShortcutBindings, theme?: Theme): string[] {
  const modelKey = actionShortcutLabel(bindings, "app.model.cycleForward", "Ctrl+P");
  const thinkingKey = actionShortcutLabel(bindings, "app.thinking.cycle", "Shift+Tab");
  const primary = [shortcutHint("Enter", "send", theme), shortcutHint("Esc", "stop/hide", theme), shortcutHint("?", "keys", theme)].join(" · ");
  const secondary = [shortcutHint("Alt+W", "hide", theme), shortcutHint(modelKey, "model", theme), shortcutHint(thinkingKey, "think", theme)];
  const candidates = [
    [primary, ...secondary].join(" · "),
    [primary, ...secondary.slice(0, 2)].join(" · "),
    [primary, secondary[0]].join(" · "),
    primary,
    [shortcutHint("Enter", "send", theme), shortcutHint("?", "keys", theme)].join(" · "),
    shortcutHint("?", "keys", theme),
  ];
  const line = candidates.find((candidate) => visibleWidth(candidate) <= width);
  return line ? [line] : [];
}
