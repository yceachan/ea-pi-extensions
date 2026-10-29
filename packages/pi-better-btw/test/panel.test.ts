import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, colorToOklch, colorToRgb, foregroundAnsi, rgbColor, stripTerminalSequences, visibleWidth, type TerminalColorMode } from "@earendil-works/pi-tui";
import { derivePanelColors, paintPanel, PanelPalette } from "../srcs/side-chat-panel.ts";
import { currentTheme } from "./theme-fixture.ts";

initTheme("dark");
function themed(appearance: "dark" | "light", mode: TerminalColorMode = "truecolor") {
  initTheme(appearance);
  return {
    appearance,
    colors: { ...currentTheme.colors },
    getColorMode: () => mode,
  } as Theme;
}

describe("theme-derived side-panel palette", () => {
  test("colored terminal backgrounds retain tint and signed lightness separation", () => {
    try {
      for (const appearance of ["dark", "light"] as const) {
        const theme = themed(appearance);
        const background = appearance === "dark" ? rgbColor(24, 32, 56) : rgbColor(242, 235, 222);
        Object.assign(theme.colors, { userMessageBg: background });
        const colors = derivePanelColors(theme, { background });
        const direction = appearance === "dark" ? 1 : -1;
        expect(direction * (colorToOklch(colors.body).l - colorToOklch(background).l)).toBeGreaterThan(0.02);
        expect(direction * (colorToOklch(colors.input).l - colorToOklch(colors.body).l)).toBeGreaterThan(0.02);
        expect(colorToOklch(colors.body).c).toBeGreaterThan(0.005);
        expect(colors.user).toBe(background);
      }
    } finally { initTheme("dark"); }
  });

  test("black/white fallbacks and input remain distinct after 256-color quantization", () => {
    try {
      for (const appearance of ["dark", "light"] as const) {
        const theme = themed(appearance, "256color");
        const { body, input } = derivePanelColors(theme);
        const main = appearance === "dark" ? rgbColor(0, 0, 0) : rgbColor(255, 255, 255);
        expect(backgroundAnsi(body, "256color")).not.toBe(backgroundAnsi(main, "256color"));
        expect(backgroundAnsi(input, "256color")).not.toBe(backgroundAnsi(body, "256color"));
        expect(paintPanel(theme, "input", "draft", 20)).toStartWith(backgroundAnsi(input, "256color"));
      }
    } finally { initTheme("dark"); }
  });

  test("subtle input surfaces remain distinct on mid-gray 256-color terminals and mode changes", () => {
    try {
      for (const appearance of ["dark", "light"] as const) {
        const theme = themed(appearance, "256color");
        for (const gray of appearance === "dark" ? [30, 50, 70] : [180, 210, 240]) {
          const palette = new PanelPalette();
          palette.setTerminalColors({ background: { r: gray, g: gray, b: gray } });
          const colors = palette.get(theme);
          expect(backgroundAnsi(colors.input, "256color")).not.toBe(backgroundAnsi(colors.body, "256color"));
          const previous = colors;
          theme.getColorMode = () => "truecolor";
          expect(palette.get(theme)).not.toBe(previous);
          theme.getColorMode = () => "256color";
        }
      }
    } finally { initTheme("dark"); }
  });

  test("palette detects live theme switches and retains known colors after partial replies", () => {
    const palette = new PanelPalette();
    try {
      initTheme("dark");
      const dark = palette.get(currentTheme);
      expect(palette.get(currentTheme)).toBe(dark);
      initTheme("light");
      expect(palette.get(currentTheme)).not.toBe(dark);
      palette.setTerminalColors({ background: { r: 232, g: 240, b: 255 } });
      const known = palette.get(currentTheme);
      palette.setTerminalColors({ background: undefined });
      expect(colorToRgb(palette.get(currentTheme).body)).toEqual(colorToRgb(known.body));
      palette.setTerminalColors({ background: { r: 240, g: 232, b: 220 } });
      expect(colorToRgb(palette.get(currentTheme).body)).not.toEqual(colorToRgb(known.body));
    } finally { initTheme("dark"); }
  });

  test("painting preserves explicit RGB backgrounds, syntax colors and inverse selection", () => {
    const theme = themed("dark");
    const body = backgroundAnsi(derivePanelColors(theme).body, theme.getColorMode());
    const text = "\x1b[48;2;0;39;49mcode\x1b[49;39m \x1b[38;5;49msyntax\x1b[0;1m \x1b[7mselected\x1b[27m";
    const line = paintPanel(theme, "body", text, 50);
    expect(line).toContain("\x1b[48;2;0;39;49mcode");
    expect(line).toContain("\x1b[38;5;49msyntax");
    expect(line).toContain(`code${body}${foregroundAnsi(theme.colors.text, theme.getColorMode())}`);
    expect(line).toContain(`\x1b[0m${body}`);
    expect(line).toContain("\x1b[7mselected\x1b[27m");
    expect(stripTerminalSequences(line).trimEnd()).toBe("code syntax selected");
    expect(visibleWidth(line)).toBe(50);
  });
});
