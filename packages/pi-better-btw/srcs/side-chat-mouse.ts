import type { Terminal } from "@earendil-works/pi-tui";

/**
 * Minimal SGR mouse support for the side chat overlay.
 *
 * pi-tui has no built-in mouse handling in regular (non-fullscreen) mode,
 * so the extension enables xterm mouse reporting (button-event tracking +
 * button-event motion tracking + SGR extended coordinates) while the side
 * chat is open and consumes the sequences before they could leak into the
 * editor as garbage input.
 *
 * Wheel events arrive as button 64 (scroll up) / 65 (scroll down), drags as
 * motion events (button | 32), all SGR encoded: ESC [ < B ; Cx ; Cy M (press)
 * / m (release).
 */

export interface SgrMouseEvent {
  /** SGR button code (0 = left, 1 = middle, 2 = right, 64 = wheel up, 65 = wheel down, ...) */
  button: number;
  /** 1-based column */
  col: number;
  /** 1-based row */
  row: number;
  isRelease: boolean;
}

/** Button-event tracking + button-event motion tracking + SGR extended coordinates */
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export const WHEEL_UP_BUTTON = 64;
export const WHEEL_DOWN_BUTTON = 65;
/** SGR motion flag: drag events are reported as (button | 32). */
const MOTION_FLAG = 32;

export function enableMouseReporting(terminal: Terminal): void {
  terminal.write(MOUSE_ENABLE);
}

export function disableMouseReporting(terminal: Terminal): void {
  terminal.write(MOUSE_DISABLE);
}

/** Parse an SGR mouse sequence (complete, as emitted by StdinBuffer). */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | null {
  const match = SGR_MOUSE_RE.exec(data);
  if (!match) return null;
  return {
    button: parseInt(match[1], 10),
    col: parseInt(match[2], 10),
    row: parseInt(match[3], 10),
    isRelease: match[4] === "m",
  };
}

/** True for wheel press events (button 64/65). Wheel releases (67/68) are ignored. */
export function isWheelEvent(event: SgrMouseEvent): boolean {
  return !event.isRelease && (event.button === WHEEL_UP_BUTTON || event.button === WHEEL_DOWN_BUTTON);
}

/** Scroll direction of a wheel event: 1 = toward older content, -1 = toward latest. */
export function wheelDirection(event: SgrMouseEvent): 1 | -1 {
  return event.button === WHEEL_UP_BUTTON ? 1 : -1;
}

/** True for an unmodified left-button press (button 0). */
export function isLeftPress(event: SgrMouseEvent): boolean {
  return !event.isRelease && (event.button & MOTION_FLAG) === 0 && (event.button & 3) === 0;
}

/** True for a left-button drag motion (button 32 with the left button held). */
export function isLeftDrag(event: SgrMouseEvent): boolean {
  return !event.isRelease && (event.button & MOTION_FLAG) !== 0 && (event.button & 3) === 0;
}

/**
 * True for a left-button release. Terminals report the release either with
 * the plain button code (0) or with the release bit set (3); wheel releases
 * (67/68) are excluded.
 */
export function isLeftRelease(event: SgrMouseEvent): boolean {
  if (!event.isRelease) return false;
  if ((event.button & 64) !== 0) return false; // wheel release
  const button = event.button & 3;
  return button === 0 || button === 3;
}
