// Test-only access to Pi's live proxy; production receives Theme from the host.
// Resolve from the package entry so isolated and hoisted workspaces both work.
import type { Theme } from "@earendil-works/pi-coding-agent";
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const themeModule = new URL("./modes/interactive/theme/theme.js", entry);
export const { theme: currentTheme } = await import(themeModule.href) as { theme: Theme };

/** Keep layout snapshots ANSI-free while providing real resolved theme colors. */
export const layoutTheme: any = {
  fg: (_name: string, text: string) => text,
  getFgAnsi: () => "",
  get colors() { return currentTheme.colors; },
  get appearance() { return currentTheme.appearance; },
  getColorMode: () => currentTheme.getColorMode(),
};
