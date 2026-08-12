import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	hyperlink,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import { getShell, listShells, stopShell, withRegistryLock } from "./shells";

/**
 * ⭕shell TUI monitor (wayfinder ticket T4).
 *
 * Keyboard-first monitor overlay with two pages, per the T4 spec images
 * (`docs/agents/spec/ps.png`, `docs/agents/spec/tui.png`):
 *
 * - LIST ("Background"): every RUNNING shell (to-close shells are invisible —
 *   the TUI is a pure monitor per ADR-0001) with `(running)` teal, `❯`
 *   selection marker, subtitle "N active shells", and the key-hint footer.
 * - DETAILS ("Shell details"): status / runtime / command rows, a bordered
 *   live log box (URLs become clickable OSC 8 hyperlinks), the italic
 *   `Showing N lines of M bytes` stats line, and the key-hint footer.
 *
 * Activation: `alt+s` shortcut (no default binding in
 * `docs/keybindings.md`; "s" for shells — the choice is documented in the
 * T4 summary) and the `/shelld` command. Both are no-ops outside TUI mode.
 *
 * Palette: the spec defines an exact dark palette (teal #00D9D9 / #00C7C7,
 * border #B8C1DD, backgrounds #20202F / #1F1E30). pi's theme colors are
 * 16-color palette names and cannot express those hexes, so this module
 * paints its own spec-fixed palette instead of theme colors (documented
 * deviation from pi's "use theme from callback" guidance — the overlay
 * paints its own background, so it reads correctly on any pi theme).
 *
 * Data: all state comes from the T5 state module (`listShells()` /
 * `getShell()` + tailing the shell's log file). Status is derived from pid
 * liveness; runtime from `startedAt`. The monitor re-renders on a fixed
 * tick (500ms) so logs, statuses and runtimes stay live; the tick is
 * cleared in `dispose()` (pi disposes overlay components on close).
 */

/** T4 spec palette. */
const SPEC = {
	tealList: "#00D9D9", // LIST page accent
	tealDetails: "#00C7C7", // DETAILS page accent
	border: "#B8C1DD", // output box border
	gray: "#949AA8", // subtitles, labels, footers
	bgList: "#20202F",
	bgDetails: "#1F1E30",
} as const;

/** Live-update tick for the monitor overlay. */
const REFRESH_MS = 500;
/** Read window for tailing very large logs (bytes from the file end). */
const TAIL_MAX_BYTES = 512 * 1024;

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
const FG_DEFAULT = "\x1b[39m";

function truecolor(code: number, hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[${code};2;${r};${g};${b}m`;
}

const fg = (hex: string): string => truecolor(38, hex);
const bg = (hex: string): string => truecolor(48, hex);

/**
 * Paint one terminal line: spec background at the start, content, then
 * plain spaces right-padded to `width`. The TUI appends a full SGR reset at
 * the end of every rendered line, so each line must carry its own styling.
 */
function paintLine(content: string, width: number, bgHex: string): string {
	const pad = width - visibleWidth(content);
	return bg(bgHex) + content + (pad > 0 ? " ".repeat(pad) : "");
}

/** "1m 1s" style elapsed-time formatting (spec shows `Runtime: 1m 1s`). */
function formatRuntime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

interface LogTail {
	/** Last lines of the log, newest last (capped at `maxLines`). */
	lines: string[];
	/** Full log size on disk in bytes — the "M bytes" of the stats line. */
	totalBytes: number;
}

/**
 * Tail the last `maxLines` lines of a shell's log file. Huge logs are read
 * from the end (last TAIL_MAX_BYTES, cut at the first newline boundary).
 * Missing/unreadable logs (shell never wrote anything) yield an empty tail.
 */
function tailLog(logFile: string, maxLines: number): LogTail {
	try {
		const size = fs.statSync(logFile).size;
		let raw: string;
		if (size <= TAIL_MAX_BYTES) {
			raw = fs.readFileSync(logFile, "utf8");
		} else {
			const fd = fs.openSync(logFile, "r");
			try {
				const buf = Buffer.alloc(TAIL_MAX_BYTES);
				const read = fs.readSync(
					fd,
					buf,
					0,
					TAIL_MAX_BYTES,
					size - TAIL_MAX_BYTES,
				);
				raw = buf.subarray(0, read).toString("utf8");
				// Drop the partial first line; keep everything from its newline on.
				const nl = raw.indexOf("\n");
				if (nl >= 0 && nl < raw.length - 1) raw = raw.slice(nl + 1);
			} finally {
				fs.closeSync(fd);
			}
		}
		const all = raw.split("\n");
		if (all.length > 0 && all[all.length - 1] === "") all.pop();
		return { lines: all.slice(-maxLines), totalBytes: size };
	} catch {
		return { lines: [], totalBytes: 0 };
	}
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>'"`]+$/;

/**
 * Wrap http(s) URLs in OSC 8 hyperlinks (`hyperlink()` from pi-tui).
 * Applied to already-truncated plain text so a link never changes the line
 * width. The color/underline reset is attribute-scoped (no full SGR reset)
 * so the line's painted background survives mid-line.
 */
function linkify(text: string): string {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(URL_RE)) {
		const raw = match[0];
		const url = raw.replace(TRAILING_PUNCT_RE, "");
		if (!url) continue;
		out +=
			text.slice(last, match.index) +
			fg(SPEC.tealDetails) +
			UNDERLINE +
			hyperlink(url, url) +
			UNDERLINE_OFF +
			FG_DEFAULT;
		last = match.index + raw.length;
	}
	return out + text.slice(last);
}

/**
 * Prepare one log line for the output box: strip whatever ANSI/OSC the
 * spawned process emitted, drop a trailing `\r`, truncate to the box's
 * content width, then re-linkify URLs.
 */
function decorateLogLine(raw: string, maxWidth: number): string {
	const clean = stripTerminalSequences(raw).replace(/\r+$/, "");
	return linkify(truncateToWidth(clean, maxWidth, ""));
}

type View = { kind: "list" } | { kind: "details"; shellId: string };

/**
 * The monitor overlay component: one component, two pages, a list<->details
 * state machine. Reads shell state on every render (no caching — the data
 * is live by design).
 */
class ShellMonitor implements Component {
	private view: View = { kind: "list" };
	private selected = 0;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly close: () => void,
	) {
		// Live updates: statuses shift when pids die, logs grow, runtimes tick.
		this.refreshTimer = setInterval(() => tui.requestRender(), REFRESH_MS);
	}

	/** Called by pi when the overlay closes (`done()`) — stop the live tick. */
	dispose(): void {
		clearInterval(this.refreshTimer);
	}

	// No cached render state; everything is rebuilt per render, so theme
	// changes need no special handling either.
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.view.kind === "list") {
			const shells = listShells().filter((s) => s.status === "running");
			if (matchesKey(data, Key.up)) {
				if (this.selected > 0) this.selected--;
			} else if (matchesKey(data, Key.down)) {
				if (this.selected < shells.length - 1) this.selected++;
			} else if (matchesKey(data, Key.enter)) {
				const shell = shells[this.selected];
				if (shell) this.view = { kind: "details", shellId: shell.id };
			} else if (data === "x") {
				const shell = shells[this.selected];
				if (shell) void this.stopShell(shell.id);
			} else if (matchesKey(data, Key.escape)) {
				this.close();
				return;
			} else {
				return;
			}
		} else {
			const { shellId } = this.view;
			if (matchesKey(data, Key.left)) {
				this.view = { kind: "list" };
			} else if (
				matchesKey(data, Key.escape) ||
				matchesKey(data, Key.enter) ||
				matchesKey(data, Key.space)
			) {
				this.close();
				return;
			} else if (data === "x") {
				void this.stopShell(shellId);
			} else {
				return;
			}
		}
		this.tui.requestRender();
	}

	/** Tree-kill one shell (x = stop, initiator user), serialized against in-flight tool calls. */
	private async stopShell(shellId: string): Promise<void> {
		await withRegistryLock(() => stopShell(shellId, "user"));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = this.tui.terminal.rows;
		if (this.view.kind === "list") return this.renderList(width, height);
		return this.renderDetails(width, height, this.view.shellId);
	}

	// ------------------------------------------------------------------
	// LIST page — "Background"
	// ------------------------------------------------------------------

	private renderList(width: number, height: number): string[] {
		// Pure monitor (ADR-0001): only running shells are shown; to-close
		// shells are invisible and swept by the agent (close) or session end.
		const shells = listShells().filter((s) => s.status === "running");
		if (this.selected > shells.length - 1) {
			this.selected = Math.max(0, shells.length - 1);
		}
		const active = shells.length;
		const lines: string[] = [];
		const push = (content: string) =>
			lines.push(paintLine(content, width, SPEC.bgList));

		push(fg(SPEC.tealList) + BOLD + "Background");
		push(fg(SPEC.gray) + `${active} active shell${active === 1 ? "" : "s"}`);
		push("");

		if (shells.length === 0) {
			push(
				fg(SPEC.gray) +
					"No running shells. Start one with the shell_daemon tool.",
			);
		} else {
			// Rows end 3 lines above the bottom: 1 blank + footer + 1 blank.
			const maxRows = Math.max(1, height - 3 - lines.length);
			const truncated = shells.length > maxRows;
			const shown = truncated ? shells.slice(0, maxRows - 1) : shells;
			for (const [i, shell] of shown.entries()) {
				const marker =
					i === this.selected ? fg(SPEC.tealList) + BOLD + "❯" : " ";
				const statusFg = fg(SPEC.tealList);
				const label = (shell.name ? `[${shell.name}] ` : "") + shell.command;
				push(
					`${marker} ${truncateToWidth(label, Math.max(4, width - 16), "")} ` +
						`${statusFg}(${shell.status})`,
				);
			}
			if (truncated) {
				const more = shells.length - shown.length;
				push(fg(SPEC.gray) + `… ${more} more shell${more === 1 ? "" : "s"}`);
			}
		}

		while (lines.length < height - 2) push("");
		push(
			fg(SPEC.gray) +
				"↑/↓ to select · Enter to view · x to stop · Esc to close",
		);
		push("");
		return lines;
	}

	// ------------------------------------------------------------------
	// DETAILS page — "Shell details"
	// ------------------------------------------------------------------

	private renderDetails(
		width: number,
		height: number,
		shellId: string,
	): string[] {
		const shell = getShell(shellId);
		const lines: string[] = [];
		const push = (content: string) =>
			lines.push(paintLine(content, width, SPEC.bgDetails));
		const gray = fg(SPEC.gray);

		push(fg(SPEC.tealDetails) + BOLD + "Shell details");
		push("");
		if (!shell) {
			push(gray + "Shell not found.");
			push(gray + `id: ${shellId}`);
		} else {
			const statusFg = shell.status === "running" ? fg(SPEC.tealDetails) : gray;
			push(gray + "Status:  " + statusFg + shell.status);
			push(gray + "Runtime: " + formatRuntime(Date.now() - shell.startedAt));
			const label = (shell.name ? `[${shell.name}] ` : "") + shell.command;
			push(
				gray +
					"Command: " +
					truncateToWidth(label, Math.max(4, width - 16), ""),
			);
		}
		push("");
		push(gray + "Output:");

		// Bordered log box. Bottom area is reserved for: stats line, blank,
		// footer, blank — so the box ends at `height - 4`.
		const boxWidth = Math.max(12, width - 4);
		const inner = boxWidth - 2;
		const contentWidth = Math.max(1, inner - 2);
		const boxTop = lines.length;
		const boxBottom = Math.max(boxTop + 3, height - 4);
		const logLines = Math.max(1, boxBottom - boxTop - 2);
		const tail = shell
			? tailLog(shell.logFile, logLines)
			: { lines: [] as string[], totalBytes: 0 };

		const edge = (left: string, right: string) =>
			fg(SPEC.border) + left + "─".repeat(boxWidth - 2) + right;
		const row = (content: string) =>
			fg(SPEC.border) +
			"│ " +
			content +
			" ".repeat(Math.max(0, inner - 2 - visibleWidth(content))) +
			" │";

		push(edge("╭", "╮"));
		for (const raw of tail.lines) {
			push(row(decorateLogLine(raw, contentWidth)));
		}
		for (let i = tail.lines.length; i < logLines; i++) push(row(""));
		push(edge("╰", "╯"));

		push(
			gray +
				ITALIC +
				`Showing ${tail.lines.length} lines of ${tail.totalBytes} bytes`,
		);
		while (lines.length < height - 2) push("");
		push(gray + "← to go back · Esc/Enter/Space to close · x to stop");
		push("");
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Registration & activation
// ---------------------------------------------------------------------------

/** True while the monitor overlay is open, so re-triggering is a no-op. */
let monitorOpen = false;

/**
 * Refresh the footer status entry: `⭕shell N` while running shells exist,
 * `undefined` when none (to-close shells are invisible — ADR-0001). Called
 * on session start and after every shell_daemon tool call (start/stop/close)
 * so the entry stays in sync.
 */
export function syncShellFooterStatus(ctx: ExtensionContext): void {
	const running = listShells().filter((s) => s.status === "running").length;
	ctx.ui.setStatus(
		"shelld",
		running > 0 ? `A+s→⭕shell ${running}` : undefined,
	);
}

/** Clear the footer status entry (session teardown). */
export function clearShellFooterStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus("shelld", undefined);
}

async function showMonitorOverlay(ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, _theme, _keybindings, done) =>
			new ShellMonitor(tui, () => done(undefined)),
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-center",
			},
		},
	);
	// The overlay is disposed on close; counts may have changed (x to stop).
	monitorOpen = false;
	syncShellFooterStatus(ctx);
}

function openMonitor(ctx: ExtensionContext): void {
	if (monitorOpen) return;
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"⭕shell monitor is only available in interactive (TUI) mode",
			"warning",
		);
		return;
	}
	monitorOpen = true;
	void showMonitorOverlay(ctx);
}

/**
 * Register the ⭕shell monitor: `alt+s` shortcut, `/shelld` command,
 * and the footer-status sync on shell_daemon tool activity. Safe to call at
 * extension load — the UI is only touched from session-bound contexts.
 */
export function registerTuiMonitor(pi: ExtensionAPI): void {
	// Keep the ⭕shell footer entry in sync with shell_daemon start/stop.
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "shell_daemon") syncShellFooterStatus(ctx);
	});

	// alt+s — no default pi binding (checked docs/keybindings.md:
	// editor, select, app, session, model, tree and scoped-models actions);
	// "s" for shells. See the T4 summary for the key-choice rationale.
	pi.registerShortcut("alt+s", {
		description: "Open the ⭕shell monitor (shell list + details)",
		handler: (ctx) => openMonitor(ctx),
	});

	pi.registerCommand("shelld", {
		description: "Open the ⭕shell monitor (shell list + details)",
		handler: async (_args, ctx) => openMonitor(ctx),
	});
}
