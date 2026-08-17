import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PromptPackManifest } from "./prompt-pack.ts";

/**
 * Layered config resolution for pi-better-btw.
 *
 * Sources, in increasing precedence (a layer only contributes keys it
 * actually defines — absent/invalid keys fall through to the layer below):
 *
 *   1. bundle   — <extensionDir>/config.json            (shipped defaults)
 *   2. user     — ~/.pi/agent/pi-better-btw/config.json (personal defaults)
 *   3. project  — <cwd>/.pi/pi-better-btw/config.json   (per-project overrides)
 *
 * Merge semantics:
 * - `readOnlyExtensionAllowlist` is UNIONED across layers in bundle → user →
 *   project order (deduped, first occurrence wins). A higher layer adds tools,
 *   it never drops the defaults shipped below it.
 * - `readOnlyExtensionAllowlistExclude` removes names from the final list, so
 *   a bundled default can be dropped explicitly.
 * - `promptPack` merges per leaf key (framing / focusAnchor / each lane
 *   reminder), higher layer wins; relative paths resolve against the layer's
 *   own directory (so a user-level manifest may live next to the user config).
 *
 * Loaded fresh at every side-chat open — no caching, so edits to any layer
 * apply on the next open (same philosophy as the prompt pack).
 */

export interface SideChatConfig {
  readOnlyExtensionAllowlist: string[];
  promptPack: PromptPackManifest | undefined;
}

export interface LoadConfigOptions {
  /** Directory of the extension bundle (base for the bundle config.json). */
  extensionDir: string;
  /** Current working directory; project layer is skipped when absent. */
  cwd?: string;
  /** User config dir override (tests). Defaults to ~/.pi/agent/pi-sidechat. */
  userConfigDir?: string;
  /** Surfaces config problems (invalid JSON) instead of logging to console. */
  onWarning?: (message: string) => void;
}

export const CONFIG_SUBDIR = "pi-better-btw";
export const USER_CONFIG_DIR = join(homedir(), ".pi", "agent", CONFIG_SUBDIR);

interface ConfigLayer {
  readOnlyExtensionAllowlist: string[] | undefined;
  readOnlyExtensionAllowlistExclude: string[] | undefined;
  promptPack: PromptPackManifest | undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  );
  return names.length > 0 ? names : undefined;
}

/** Resolve a prompt-pack path against the layer's dir; non-strings stay undefined. */
function resolvePath(value: unknown, dir: string): string | undefined {
  if (typeof value !== "string") return undefined;
  return isAbsolute(value) ? value : join(dir, value);
}

function parsePromptPack(
  value: unknown,
  dir: string,
): PromptPackManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const rec = value as Record<string, unknown>;
  const lane = rec.laneReminders;
  const laneRec =
    lane && typeof lane === "object" && !Array.isArray(lane)
      ? (lane as Record<string, unknown>)
      : undefined;
  return {
    framing: resolvePath(rec.framing, dir),
    focusAnchor: resolvePath(rec.focusAnchor, dir),
    laneReminders: {
      base: resolvePath(laneRec?.base, dir),
      escalated: resolvePath(laneRec?.escalated, dir),
      failedNote: resolvePath(laneRec?.failedNote, dir),
      preamble: resolvePath(laneRec?.preamble, dir),
    },
  };
}

function parseConfigLayer(raw: unknown, dir: string): ConfigLayer {
  const rec =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    readOnlyExtensionAllowlist: parseStringArray(
      rec.readOnlyExtensionAllowlist,
    ),
    readOnlyExtensionAllowlistExclude: parseStringArray(
      rec.readOnlyExtensionAllowlistExclude,
    ),
    promptPack: parsePromptPack(rec.promptPack, dir),
  };
}

/** Read one config file; absent or invalid JSON contributes nothing (with a warning). */
function readLayer(
  path: string,
  dir: string,
  onWarning?: (message: string) => void,
): ConfigLayer {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parseConfigLayer(raw, dir);
  } catch {
    if (existsSync(path) && onWarning) {
      // Present but unreadable: warn instead of silently ignoring a typo.
      onWarning(`pi-better-btw: ignoring invalid config ${path}`);
    }
    return parseConfigLayer(undefined, dir);
  }
}

/** Union allowlists bundle → user → project, then apply excludes. */
function mergeAllowlists(layers: ConfigLayer[]): string[] {
  const names: string[] = [];
  for (const layer of layers) {
    for (const name of layer.readOnlyExtensionAllowlist ?? []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const excluded = new Set<string>();
  for (const layer of layers) {
    for (const name of layer.readOnlyExtensionAllowlistExclude ?? [])
      excluded.add(name);
  }
  return names.filter((name) => !excluded.has(name));
}

/** Per-leaf-key promptPack merge, higher layer wins; undefined when nothing defined. */
function mergePromptPacks(
  layers: ConfigLayer[],
): PromptPackManifest | undefined {
  const merged: PromptPackManifest = {};
  const lane: NonNullable<PromptPackManifest["laneReminders"]> = {};
  let defined = false;
  for (const layer of layers) {
    const pack = layer.promptPack;
    if (!pack) continue;
    if (pack.framing !== undefined) {
      merged.framing = pack.framing;
      defined = true;
    }
    if (pack.focusAnchor !== undefined) {
      merged.focusAnchor = pack.focusAnchor;
      defined = true;
    }
    const layerLane = pack.laneReminders ?? {};
    for (const key of [
      "base",
      "escalated",
      "failedNote",
      "preamble",
    ] as const) {
      if (layerLane[key] !== undefined) {
        lane[key] = layerLane[key];
        defined = true;
      }
    }
  }
  if (Object.keys(lane).length > 0) merged.laneReminders = lane;
  return defined ? merged : undefined;
}

export function loadConfig(options: LoadConfigOptions): SideChatConfig {
  const layers: ConfigLayer[] = [];
  layers.push(
    readLayer(
      join(options.extensionDir, "config.json"),
      options.extensionDir,
      options.onWarning,
    ),
  );
  const userConfigDir = options.userConfigDir ?? USER_CONFIG_DIR;
  layers.push(
    readLayer(
      join(userConfigDir, "config.json"),
      userConfigDir,
      options.onWarning,
    ),
  );
  if (options.cwd) {
    const projectDir = join(options.cwd, ".pi", CONFIG_SUBDIR);
    layers.push(
      readLayer(join(projectDir, "config.json"), projectDir, options.onWarning),
    );
  }
  return {
    readOnlyExtensionAllowlist: mergeAllowlists(layers),
    promptPack: mergePromptPacks(layers),
  };
}
