// What the settings file means. Rust reads `~/.config/herdr/config-tauri.toml`
// as JSON (`settings_load`) and writes one key at a time (`settings_set`);
// this turns the JSON into a typed `Settings`, every key optional with a
// default. A key the file gets wrong becomes a warning, never a failed load.

import { invoke } from "@tauri-apps/api/core";
import { BUILTIN_NAMES, DEFAULT_THEME_NAME, HERDR_NIGHT, type NamedTheme, builtinTheme, named, parseThemeName } from "../themes/catalog";
import { parseGhostty } from "../themes/ghostty";
import { HUE_SLOTS, type HueSlot, isHueSlot } from "./hue";

/// How a workspace card's details open: by its chevron, always or never.
export const CARD_DETAILS = ["manual", "always", "never"] as const;
export type CardDetailsMode = (typeof CARD_DETAILS)[number];

const isCardDetails = (value: unknown): value is CardDetailsMode => CARD_DETAILS.includes(value as CardDetailsMode);

export interface Settings {
  /// A theme name, path, or `light:…,dark:…` pair.
  theme: string;
  terminal: {
    fontFamily: string;
    fontSize: number;
    /// Row height as a multiple of the font size.
    lineHeight: number;
  };
  ui: {
    fontSize: number;
  };
  /// Ask before closing a tab or pane stops an agent mid-task.
  confirmCloseTab: boolean;
  /// Tabs that do not fit wrap onto more rows; off keeps one row that scrolls.
  tabsWrap: boolean;
  /// What a new tab runs; `null` is the shell.
  newTabCommand: string | null;
  /// The palette slot chosen for a workspace, by its folder.
  workspaceColors: Record<string, HueSlot>;
  /// What every workspace card shows. Nothing here may hide an agent that needs you.
  workspaceCards: {
    /// The Git counts: to push, to pull, changed files.
    gitStatus: boolean;
    /// The status marks and tally on the card's head.
    agentStatus: boolean;
    details: CardDetailsMode;
    /// Tighter rows, so more workspaces fit.
    compact: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME_NAME,
  terminal: { fontFamily: "JetBrains Mono", fontSize: 13, lineHeight: 1.4 },
  ui: { fontSize: 13 },
  confirmCloseTab: true,
  tabsWrap: true,
  newTabCommand: null,
  workspaceColors: {},
  workspaceCards: { gitStatus: true, agentStatus: true, details: "manual", compact: false },
};

/// The ranges a number setting accepts.
export const LIMITS = {
  "terminal.font_size": [8, 32],
  "terminal.line_height": [1, 2],
  "ui.font_size": [10, 18],
} as const;

export interface Loaded {
  settings: Settings;
  /// What the file got wrong, for the dismissible warning strip.
  warnings: string[];
  /// The file, for the foot of the Settings dialog.
  path: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/// `values`, the file as JSON, as `Settings`. `fileError` is why the file did not parse.
export function parseSettings(values: unknown, fileError: string | null = null): { settings: Settings; warnings: string[] } {
  const warnings: string[] = [];
  if (fileError) warnings.push(`The settings file does not parse, so every setting is at its default: ${fileError}`);
  const root = isObject(values) ? values : {};
  const settings = structuredClone(DEFAULT_SETTINGS);
  const seen = new Set<string>();
  const get = (key: string): unknown => {
    seen.add(key);
    const [head, tail] = key.split(".");
    const value = root[head];
    return tail === undefined ? value : isObject(value) ? value[tail] : undefined;
  };
  const wrong = (key: string, want: string, fallback: unknown) =>
    warnings.push(`\`${key}\` should be ${want}; using ${JSON.stringify(fallback)}.`);
  const text = (key: string, fallback: string, allowEmpty = false): string => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (typeof value === "string" && (allowEmpty || value.trim())) return value.trim();
    wrong(key, "text", fallback);
    return fallback;
  };
  const number = (key: keyof typeof LIMITS, fallback: number): number => {
    const value = get(key);
    if (value === undefined) return fallback;
    const [min, max] = LIMITS[key];
    if (typeof value === "number" && value >= min && value <= max) return value;
    wrong(key, `a number from ${min} to ${max}`, fallback);
    return fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (typeof value === "boolean") return value;
    wrong(key, "true or false", fallback);
    return fallback;
  };

  const theme = text("theme", settings.theme);
  if (parseThemeName(theme)) settings.theme = theme;
  else wrong("theme", "a theme name, a path, or light:NAME,dark:NAME", settings.theme);
  settings.terminal.fontFamily = text("terminal.font_family", settings.terminal.fontFamily);
  settings.terminal.fontSize = number("terminal.font_size", settings.terminal.fontSize);
  settings.terminal.lineHeight = number("terminal.line_height", settings.terminal.lineHeight);
  settings.ui.fontSize = number("ui.font_size", settings.ui.fontSize);
  settings.confirmCloseTab = flag("confirm_close_tab", settings.confirmCloseTab);
  settings.tabsWrap = flag("tabs.wrap", settings.tabsWrap);
  const command = text("new_tab.command", "", true);
  // One line, typed into a shell: a control character would run or edit more than it.
  if (command.length > 1024 || /[\u0000-\u001f\u007f]/.test(command)) wrong("new_tab.command", "one line of at most 1024 characters", null);
  else settings.newTabCommand = command || null;
  const colors = get("workspace_colors");
  if (isObject(colors)) {
    for (const [folder, slot] of Object.entries(colors)) {
      if (isHueSlot(slot)) settings.workspaceColors[folder] = slot;
      else warnings.push(`\`workspace_colors\` for ${folder} should be one of ${HUE_SLOTS.join(", ")}; using its automatic color.`);
    }
  } else if (colors !== undefined) {
    warnings.push("`workspace_colors` should be a [workspace_colors] table of folders; every workspace keeps its automatic color.");
  }
  const cards = settings.workspaceCards;
  cards.gitStatus = flag("workspace_cards.git_status", cards.gitStatus);
  cards.agentStatus = flag("workspace_cards.agent_status", cards.agentStatus);
  cards.compact = flag("workspace_cards.compact", cards.compact);
  const details = get("workspace_cards.details");
  if (isCardDetails(details)) cards.details = details;
  else if (details !== undefined) wrong("workspace_cards.details", `one of ${CARD_DETAILS.join(", ")}`, cards.details);

  // Every key the file holds that nothing above read.
  const unknown = (key: string) => warnings.push(`\`${key}\` is not a setting, so it does nothing.`);
  for (const [head, value] of Object.entries(root)) {
    const section = [...seen].some((known) => known.startsWith(`${head}.`));
    if (section && isObject(value)) {
      for (const tail of Object.keys(value)) if (!seen.has(`${head}.${tail}`)) unknown(`${head}.${tail}`);
    } else if (section) {
      warnings.push(`\`${head}\` should be a [${head}] table; its settings are at their defaults.`);
    } else if (!seen.has(head)) {
      unknown(head);
    }
  }
  return { settings, warnings };
}

export async function loadSettings(): Promise<Loaded> {
  const loaded = await invoke<{ path: string; values: unknown; error: string | null }>("settings_load");
  return { ...parseSettings(loaded.values, loaded.error), path: loaded.path };
}

/// Writes one key to the file, keeping its comments; `null` removes it.
export function saveSetting(key: string, value: string | number | boolean | null): Promise<void> {
  return invoke("settings_set", { key, value });
}

/// Chooses a workspace's color, by its folder; `null` goes back to automatic.
export function saveWorkspaceColor(folder: string, slot: HueSlot | null): Promise<void> {
  return invoke("settings_set_entry", { table: "workspace_colors", entry: folder, value: slot });
}

/// The terminal's font list: the chosen face, then the usual monospace fallbacks.
export function fontStack(family: string): string {
  const quoted = family.includes(",") || family.includes('"') ? family : `"${family}"`;
  return `${quoted}, "JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace`;
}

/// Every theme a `theme` value can name: the built-ins, then Ghostty's folders.
export async function themeNames(): Promise<string[]> {
  const installed = await invoke<string[]>("theme_list").catch(() => [] as string[]);
  const builtin = new Set(BUILTIN_NAMES);
  return [...BUILTIN_NAMES, ...installed.filter((name) => !builtin.has(name))];
}

/// The theme `value` shows for the system appearance, read from a theme
/// folder or path when it is not built in. Anything that fails is Herdr
/// Night with a warning.
export async function resolveTheme(value: string, light: boolean): Promise<{ theme: NamedTheme; warning: string | null }> {
  const pair = parseThemeName(value);
  const name = pair ? (light ? pair.light : pair.dark) : DEFAULT_THEME_NAME;
  const builtin = builtinTheme(name);
  if (builtin) return { theme: builtin, warning: null };
  try {
    return { theme: named(name, parseGhostty(await invoke<string>("theme_read", { name }))), warning: null };
  } catch (error) {
    return { theme: HERDR_NIGHT, warning: `Theme ${name}: ${error instanceof Error ? error.message : String(error)}. Showing ${DEFAULT_THEME_NAME}.` };
  }
}
