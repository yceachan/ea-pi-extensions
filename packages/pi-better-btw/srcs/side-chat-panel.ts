import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi, colorToOklch, colorToRgb, foregroundAnsi, indexedColor, mixColors, oklchColor, rgbColor,
  truncateToWidth, type Color, type TerminalColors,
} from "@earendil-works/pi-tui";

export type PanelSurface = "body" | "header" | "input" | "user" | "assistant";

function contrast(first: Color, second: Color): number {
  const luminance = (color: Color) => {
    const { r, g, b } = colorToRgb(color);
    const linear = [r, g, b].map((v) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Theme-tinted panel, a distinct editor surface, and native user-message cards. */
export function derivePanelColors(theme: Theme, terminal: TerminalColors = {}): { body: Color; input: Color; user: Color } {
  const normalize = (color: Color) => {
    const reported = color.kind === "indexed" ? terminal.palette?.[color.index] : undefined;
    return reported ? rgbColor(reported.r, reported.g, reported.b) : color;
  };
  const user = normalize(theme.colors.userMessageBg);
  // These neutral defaults match Pi's guesses when OSC 11 is unavailable.
  const background = terminal.background;
  const base = background ? rgbColor(background.r, background.g, background.b)
    : theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
  const b = colorToOklch(base), seed = colorToOklch(mixColors(base, user, 0.25));
  const direction = theme.appearance === "light" ? -1 : 1;
  // A tiny OKLCH step near pure black disappears after 256-color conversion.
  let delta = Math.max(direction > 0 && b.l < 0.12 ? 0.17 - b.l : 0.055,
    Math.min(0.09, direction * (seed.l - b.l)));
  const makeBody = () => oklchColor(Math.max(0, Math.min(1, b.l + direction * delta)), seed.c, seed.h);
  let body = makeBody();
  const foreground = normalize(theme.colors.text);
  const minContrast = Math.min(4.5, contrast(foreground, base));
  for (let i = 0; i < 8 && contrast(foreground, body) < minContrast; i++) {
    delta *= 0.7;
    body = makeBody();
  }
  const panel = colorToOklch(body);
  let inputDelta = 0.04;
  const makeInput = () => oklchColor(Math.max(0, Math.min(1, panel.l + direction * inputDelta)), panel.c, panel.h);
  let input: Color = makeInput();
  for (let i = 0; i < 8 && contrast(foreground, input) < minContrast; i++) {
    inputDelta *= 0.7;
    input = makeInput();
  }
  // In 256-color mode a faint tint can quantize to the same coarse cube entry
  // as the body. Pick the nearest distinct, readable palette color instead of
  // increasing contrast until the card becomes another heavy color band.
  const mode = theme.getColorMode(), bodyAnsi = backgroundAnsi(body, mode);
  if (mode === "256color" && backgroundAnsi(input, mode) === bodyAnsi) {
    const index = Number(bodyAnsi.match(/;5;(\d+)m/)![1]);
    const visibleBody = colorToOklch(normalize(indexedColor(index)));
    const target = { ...visibleBody, l: visibleBody.l + direction * inputDelta };
    const ab = (color: typeof target) => [color.c * Math.cos(color.h * Math.PI / 180), color.c * Math.sin(color.h * Math.PI / 180)] as const;
    const [a, b] = ab(target);
    let best = Infinity;
    for (let i = 16; i < 256; i++) {
      if (i === index) continue;
      const candidate = indexedColor(i), resolved = normalize(candidate);
      if (contrast(foreground, resolved) < minContrast) continue;
      const channels = colorToOklch(resolved), [ca, cb] = ab(channels);
      const distance = (channels.l - target.l) ** 2 + (ca - a) ** 2 + (cb - b) ** 2;
      if (distance < best) { best = distance; input = candidate; }
    }
  }
  return { body, input, user };
}

/** Cache by resolved colors, never by the stable live-theme proxy alone. */
export class PanelPalette {
  private terminal: TerminalColors = {};
  private cached?: { colors: Theme["colors"]; appearance: Theme["appearance"]; mode: ReturnType<Theme["getColorMode"]>; result: ReturnType<typeof derivePanelColors> };

  setTerminalColors(colors: TerminalColors): void {
    // Timeouts / partial and late replies must not discard known colors.
    this.terminal = { ...this.terminal, ...Object.fromEntries(Object.entries(colors).filter(([, value]) => value !== undefined)) };
    this.cached = undefined;
  }

  get(theme: Theme): ReturnType<typeof derivePanelColors> {
    const colors = theme.colors, appearance = theme.appearance, mode = theme.getColorMode();
    if (!this.cached || this.cached.colors !== colors || this.cached.appearance !== appearance || this.cached.mode !== mode) {
      this.cached = { colors, appearance, mode, result: derivePanelColors(theme, this.terminal) };
    }
    return this.cached.result;
  }
}

const defaultPalette = new PanelPalette();

/** Paint each region once; preserve explicit ANSI backgrounds and inverse selection. */
export function paintPanel(theme: Theme, surface: PanelSurface, text: string, width: number, palette = defaultPalette): string {
  const colors = palette.get(theme);
  const bg = backgroundAnsi(surface === "user" ? colors.user : surface === "input" ? colors.input : colors.body, theme.getColorMode());
  const fg = foregroundAnsi(theme.colors[surface === "user" ? "userMessageText" : "text"], theme.getColorMode());
  const content = truncateToWidth(text, Math.max(0, width), "…", true)
    // Restore the owning surface after resets, including combined SGR resets.
    // Explicit 48;... backgrounds remain untouched (syntax/highlighting).
    .replace(/\x1b\[([\d;]*)m/g, (sequence, params: string) => {
      const codes = params ? params.split(";") : ["0"];
      let result = "";
      let pending: string[] = [];
      const flush = () => { if (pending.length) result += `\x1b[${pending.join(";")}m`; pending = []; };
      for (let i = 0; i < codes.length; i++) {
        const code = Number(codes[i]);
        if (code === 0 || code === 49 || code === 39) {
          flush();
          result += code === 0 ? `\x1b[0m${bg}${fg}` : code === 49 ? bg : fg;
        } else {
          pending.push(codes[i]!);
          // RGB/index payloads contain arbitrary numbers, not SGR commands.
          if (code === 38 || code === 48 || code === 58) {
            const count = codes[i + 1] === "2" ? 4 : codes[i + 1] === "5" ? 2 : 0;
            pending.push(...codes.slice(i + 1, i + 1 + count));
            i += count;
          }
        }
      }
      flush();
      return result;
    });
  return `${bg}${fg}${content}\x1b[0m`;
}
