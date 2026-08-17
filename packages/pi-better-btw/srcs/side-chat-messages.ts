import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Key, matchesKey, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * A cell position in the visible chat area: index of the rendered line
 * (as returned by {@link SideChatMessages.render}) and 0-based cell column.
 * Columns count terminal cells (visible width), so wide (CJK) characters
 * occupy two cells.
 */
export interface CellPos {
  line: number;
  col: number;
}

/** Map a terminal-cell column back to a character index in plain text. */
function colToCharIndex(plain: string, col: number): number {
  let width = 0;
  for (let i = 0; i < plain.length; ) {
    const cp = plain.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    const charWidth = visibleWidth(char);
    if (width + charWidth > col) return i;
    width += charWidth;
    i += char.length;
  }
  return plain.length;
}

/** Invert-video highlight applied to the selected cell range. */
const SELECTION_STYLE = "\x1b[7m";
const SELECTION_STYLE_END = "\x1b[27m";

// Marker for the framing block message (#9): it lives in the LLM context
// (user-role fallback placement) but must never render as a chat bubble.
const FRAMING_MARKER = Symbol("btw-framing-message");

/** Mark a message as the framing block so the render path skips it. */
export function markFramingMessage<T extends AgentMessage>(message: T): T {
  (message as T & { [FRAMING_MARKER]?: boolean })[FRAMING_MARKER] = true;
  return message;
}

/** True for framing-block messages (marked at construction). */
export function isFramingMessage(message: AgentMessage): boolean {
  return (message as AgentMessage & { [FRAMING_MARKER]?: boolean })[FRAMING_MARKER] === true;
}

export class SideChatMessages implements Component {
  private messages: AgentMessage[] = [];
  private streamingContent = "";
  private errorContent = "";
  private toolStatus = "";
  private scrollOffset = 0;
  private totalLines = 0;
  /**
   * Active mouse selection over the visible chat lines ({@link CellPos} in
   * rendered-line coordinates). Cleared on scroll / content changes and on
   * the next press; kept after copy so Ctrl+C can copy again (B+C scheme).
   */
  private selection: { anchor: CellPos; focus: CellPos } | null = null;
  /** Plain (ANSI-stripped) text of the last rendered lines, for hit-testing and copy. */
  private plainLines: string[] = [];
  /** Slice start of the last render; appended status/stream lines shift it (window coords). */
  private lastRenderStart = 0;
  /**
   * Number of leading messages injected at open time (fork context, reopened
   * history, refork). They render as ONE collapsed, non-expandable cite line
   * instead of full history. UI-only: the messages themselves stay in the
   * agent's LLM context untouched.
   */
  private injectedCount = 0;
  /**
   * While the user has scrolled away from the bottom, the content line index
   * pinned to the viewport bottom. New lines appended below it (streamed
   * output) grow the scroll offset instead of sliding the visible content.
   * Null while following the bottom.
   */
  private frozenAnchor: number | null = null;

  // --- Render cache (perf) ---
  // The conversation history is re-wrapped on EVERY render call (each mouse
  // drag motion event, each streaming delta, each 80ms spinner tick), so an
  // un-cached render that re-wraps the whole transcript cost ~21ms/frame at
  // 20 turns and ~120ms/frame at 200 turns — enough to saturate the event
  // loop and make the whole terminal stutter during selection drags and
  // lane-blocked retry loops. Caching the wrapped lines per message (keyed
  // by message identity + width) makes steady-state frames O(visible) again.
  /** Rendered lines of the injected-context cite (depends on width + injected count). */
  private prefixLines: string[] = [];
  /** Cached wrapped lines per message index (keyed by message reference + width). */
  private messageCache: string[][] = [];
  /** Message reference each cache entry was rendered from (null = needs render). */
  private messageRefs: (AgentMessage | null)[] = [];
  /** Width the caches were built for; a resize invalidates everything. */
  private cachedWidth = 0;
  /** Injected count the prefix was built for. */
  private cachedInject = -1;

  constructor(private theme: Theme, private maxVisibleLines: number) {}

  /**
   * Mark the first `count` messages as injected context: they render as a
   * single cite line (e.g. `[Context] 36 msgs`) rather than full history.
   * Anything appended after the injected batch renders normally. Pass 0
   * (Alt+N empty start) for no cite. UI-only — LLM context is unaffected.
   */
  setInjectedMessageCount(count: number) {
    this.injectedCount = Math.max(0, count);
    // The cite label/count feeds the prefix; force a rebuild on next render.
    this.cachedInject = -1;
    this.prefixLines = [];
  }

  setMessages(messages: AgentMessage[]) {
    this.messages = messages;
    // New content invalidates the mouse selection.
    this.selection = null;
    if (this.frozenAnchor === null) {
      // Following: snap the viewport to the bottom.
      this.scrollOffset = 0;
    } else {
      // Frozen: keep the anchored content line at the viewport bottom. The
      // message list only grows, so the anchor stays valid across re-renders
      // (streaming block -> completed message, tool status coming/going).
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
  }

  setStreamingContent(content: string) {
    this.streamingContent = content;
    if (content) this.errorContent = "";
  }

  setErrorContent(content: string) {
    this.errorContent = content;
    if (content) this.streamingContent = "";
  }

  setToolStatus(status: string) {
    this.toolStatus = status;
  }

  /**
   * Set the mouse selection range in rendered-line coordinates. Positions are
   * clamped to the currently rendered lines.
   */
  setSelection(anchor: CellPos, focus: CellPos) {
    this.selection = {
      anchor: this.clampPos(anchor),
      focus: this.clampPos(focus),
    };
  }

  /** Drop the active mouse selection. */
  clearSelection() {
    this.selection = null;
  }

  /** The current selection anchor (window coordinates), or null when no selection. */
  getSelectionAnchor(): CellPos | null {
    return this.selection?.anchor ?? null;
  }

  /** True when a non-empty selection is active (highlights are rendered). */
  hasSelection(): boolean {
    if (!this.selection) return false;
    const { anchor, focus } = this.selection;
    return anchor.line !== focus.line || anchor.col !== focus.col;
  }

  /** Extract the selected text (per rendered line, joined with newlines). */
  getSelectedText(): string {
    if (!this.selection) return "";
    const { anchor, focus } = this.selection;
    const start = this.orderedStart(anchor, focus);
    const end = this.orderedEnd(anchor, focus);
    const lines: string[] = [];
    for (let line = start.line; line <= end.line; line++) {
      const plain = this.plainLines[line] ?? "";
      const s = line === start.line ? colToCharIndex(plain, start.col) : 0;
      const e = line === end.line ? colToCharIndex(plain, end.col) : plain.length;
      lines.push(plain.slice(s, e).trimEnd());
    }
    return lines.join("\n");
  }

  /** Clear the tool-status line, but only while it still shows the given text. */
  clearToolStatusIf(expected: string) {
    if (this.toolStatus === expected) this.toolStatus = "";
  }

  setMaxVisibleLines(max: number) {
    this.maxVisibleLines = Math.max(1, max);
    if (this.frozenAnchor === null) {
      this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, this.totalLines - this.maxVisibleLines));
    } else {
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
  }

  /**
   * Scroll by a number of lines. Positive = toward older content (like PgUp),
   * negative = toward the latest message. Clamped to the scrollable range.
   */
  scrollBy(lines: number) {
    if (lines === 0) return false;
    // A scroll invalidates the mouse selection (rendered-line coordinates shift).
    this.selection = null;
    const maxOffset = Math.max(0, this.totalLines - this.maxVisibleLines);
    const next = Math.max(0, Math.min(this.scrollOffset + lines, maxOffset));
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    if (next === 0) {
      // Scrolled back to the bottom: resume following.
      this.frozenAnchor = null;
    } else {
      // Pin the new viewport position so arriving lines don't slide it.
      this.frozenAnchor = Math.max(0, this.totalLines - next);
    }
    return true;
  }

  /**
   * Snap to the bottom and resume bottom-following. Called when the user
   * sends a new message (the conversation restarts from the bottom).
   */
  resumeFollowing() {
    this.frozenAnchor = null;
    this.scrollOffset = 0;
    this.selection = null;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  isAtBottom(): boolean {
    return this.scrollOffset <= 0;
  }

  /**
   * (Re)build the cached prefix + per-message wrapped lines when the messages,
   * message count, or width changed. Per-message entries are re-rendered only
   * when the message object reference differs; streaming replaces one message
   * object per delta, so only that single message re-wraps per frame.
   */
  private ensureCachedLines(width: number): void {
    if (width !== this.cachedWidth) {
      this.cachedWidth = width;
      this.messageCache = [];
      this.messageRefs = [];
      this.prefixLines = [];
      this.cachedInject = -1;
    }
    const n = this.messages.length;
    const injected = Math.min(this.injectedCount, n);
    if (this.messageRefs.length !== n) {
      const prev = this.messageRefs.length;
      if (prev > n) {
        this.messageRefs.length = n;
        this.messageCache.length = n;
      } else {
        this.messageRefs.length = n;
        this.messageCache.length = n;
        for (let i = prev; i < n; i++) this.messageRefs[i] = null;
      }
    }
    for (let i = 0; i < n; i++) {
      if (i < injected) {
        // Injected batch renders as one collapsed cite line, never as bubbles.
        this.messageRefs[i] = this.messages[i];
        this.messageCache[i] = [];
        continue;
      }
      // Framing-block messages are part of the LLM context but never render
      // as chat bubbles (#9 fallback placement): cache an empty entry.
      if (isFramingMessage(this.messages[i])) {
        this.messageRefs[i] = this.messages[i];
        this.messageCache[i] = [];
        continue;
      }
      if (this.messageRefs[i] !== this.messages[i]) {
        this.messageRefs[i] = this.messages[i];
        this.messageCache[i] = this.renderMessage(this.messages[i], width);
      }
    }
    if (injected !== this.cachedInject) {
      this.cachedInject = injected;
      if (injected > 0) {
        // One collapsed, non-expandable cite line for the injected batch
        // (fresh fork context, reopened history, refork) instead of the full
        // history. The visible conversation starts after it.
        this.prefixLines = [
          ...wrapTextWithAnsi(this.theme.fg("muted", `[Context] ${injected} msg${injected === 1 ? "" : "s"}`), width),
          "",
        ];
      } else {
        this.prefixLines = [];
      }
    }
  }

  render(width: number): string[] {
    this.ensureCachedLines(width);
    const lines: string[] = [...this.prefixLines];
    const n = this.messages.length;
    for (let i = 0; i < n; i++) {
      const messageLines = this.messageCache[i];
      if (messageLines.length) {
        lines.push(...messageLines, "");
      }
    }

    // Dynamic tail (error/streaming status/tool status) is re-wrapped every
    // frame — bounded by the current chunk, orders of magnitude cheaper than
    // the stored history.
    if (this.errorContent) {
      lines.push(...wrapTextWithAnsi(this.theme.fg("error", "[Error]: ") + this.errorContent, width));
    } else if (this.streamingContent) {
      lines.push(...wrapTextWithAnsi(this.theme.fg("text", "[Assistant]: ") + this.streamingContent + "▌", width));
    }

    if (this.toolStatus) {
      if (lines.length) lines.push("");
      lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `[Tool]: ${this.toolStatus}`), width));
    }

    this.totalLines = lines.length;
    // Freeze: while the user has scrolled away, grow the offset by the lines
    // appended at the end, so the anchored content stays put instead of being
    // pushed up by new streamed output.
    if (this.frozenAnchor !== null) {
      this.scrollOffset = Math.max(0, this.totalLines - this.frozenAnchor);
    }
    const start = Math.max(0, lines.length - this.maxVisibleLines - this.scrollOffset);
    const end = Math.max(0, lines.length - this.scrollOffset);
    const visible = lines.slice(start, end);

    // Window-coordinate shift: appended status/stream lines (e.g. the "✓
    // Copied" feedback after a copy) grow the slice start while bottom-
    // following, moving the whole viewport down. The selection is stored in
    // window coordinates, so translate it by the same delta to keep the
    // highlight and Ctrl+C copy anchored to the same content. A selection
    // scrolled out of the top of the window is dropped.
    const delta = start - this.lastRenderStart;
    this.lastRenderStart = start;
    if (delta !== 0 && this.selection) {
      const shift = (p: CellPos): CellPos => ({ line: p.line - delta, col: p.col });
      const shifted = { anchor: shift(this.selection.anchor), focus: shift(this.selection.focus) };
      if (shifted.anchor.line < 0 || shifted.focus.line < 0) {
        this.selection = null;
      } else {
        this.selection = shifted;
      }
    }

    // Hit-testing and copy operate on the ANSI-stripped visible lines.
    this.plainLines = visible.map(stripTerminalSequences);
    if (this.selection && this.selection.focus.line >= visible.length) {
      // Defensive: the rendered line count shrank under the selection.
      this.selection = null;
    }
    if (this.selection) {
      for (let i = 0; i < visible.length; i++) {
        const highlighted = this.renderSelectionLine(i);
        if (highlighted !== null) visible[i] = highlighted;
      }
    }
    return visible;
  }

  /** Clamp a cell position to the currently rendered lines. */
  private clampPos(pos: CellPos): CellPos {
    const line = Math.max(0, Math.min(pos.line, Math.max(0, this.plainLines.length - 1)));
    const maxCol = Math.max(0, visibleWidth(this.plainLines[line] ?? ""));
    return { line, col: Math.max(0, Math.min(pos.col, maxCol)) };
  }

  /** Canonical (topmost-first) ordering helpers for a selection range. */
  private orderedStart(a: CellPos, b: CellPos): CellPos {
    return a.line < b.line || (a.line === b.line && a.col <= b.col) ? a : b;
  }

  private orderedEnd(a: CellPos, b: CellPos): CellPos {
    return a.line > b.line || (a.line === b.line && a.col > b.col) ? a : b;
  }

  /**
   * Re-render line `lineIndex` with the selected cell range in inverse video.
   * Returns null when the line is outside the selection. Selected lines lose
   * their theme colors while highlighted (matching terminal-native selection).
   */
  private renderSelectionLine(lineIndex: number): string | null {
    if (!this.selection) return null;
    const { anchor, focus } = this.selection;
    const start = this.orderedStart(anchor, focus);
    const end = this.orderedEnd(anchor, focus);
    if (lineIndex < start.line || lineIndex > end.line) return null;
    const plain = this.plainLines[lineIndex] ?? "";
    const s = lineIndex === start.line ? colToCharIndex(plain, start.col) : 0;
    const e = lineIndex === end.line ? colToCharIndex(plain, end.col) : plain.length;
    if (s >= e) return null;
    return plain.slice(0, s) + SELECTION_STYLE + plain.slice(s, e) + SELECTION_STYLE_END + plain.slice(e);
  }

  private renderMessage(msg: AgentMessage, width: number): string[] {
    const { theme } = this;

    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return wrapTextWithAnsi(theme.fg("accent", "[You]: ") + content, width);
    }

    if (msg.role === "assistant") {
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) return wrapTextWithAnsi(theme.fg("text", "[Assistant]: ") + text, width);
      if ("errorMessage" in msg && msg.errorMessage) {
        return wrapTextWithAnsi(theme.fg("error", "[Error]: ") + String(msg.errorMessage), width);
      }
      return [];
    }

    if (msg.role === "toolResult") {
      const fullText = msg.content[0]?.type === "text" ? msg.content[0].text : "";
      const preview = fullText.slice(0, 100);
      return wrapTextWithAnsi(theme.fg("muted", `[${msg.toolName}]: ${preview}${fullText.length > 100 ? "..." : ""}`), width);
    }

    if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
      return wrapTextWithAnsi(theme.fg("muted", `[Summary]: ${msg.summary}`), width);
    }

    if (msg.role === "bashExecution") {
      return wrapTextWithAnsi(theme.fg("muted", `[Bash]: ${msg.command}`), width);
    }

    if (msg.role === "custom" && msg.display) {
      const content = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.type === "text" ? b.text : "[image]").join("");
      return wrapTextWithAnsi(theme.fg("muted", "[Context]: ") + content, width);
    }

    return [];
  }

  handleInput(data: string): boolean {
    // PgUp / PgDn scroll by a full page; Shift+Up / Shift+Down by a few lines.
    if (matchesKey(data, Key.pageUp)) {
      return this.scrollBy(this.maxVisibleLines);
    }
    if (matchesKey(data, Key.pageDown)) {
      return this.scrollBy(-this.maxVisibleLines);
    }
    if (matchesKey(data, Key.shift("up"))) {
      return this.scrollBy(3);
    }
    if (matchesKey(data, Key.shift("down"))) {
      return this.scrollBy(-3);
    }
    return false;
  }

  invalidate() {
    // Terminal metrics (e.g. cell-size query) may have changed; drop the
    // width-keyed caches so the next render re-wraps at the current width.
    this.messageCache = [];
    this.messageRefs = [];
    this.prefixLines = [];
    this.cachedWidth = 0;
    this.cachedInject = -1;
  }
}
