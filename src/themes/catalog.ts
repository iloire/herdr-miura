// The themes the app knows by name, and what a `theme` value asks for. Names
// match herdr-gpui's built-ins, so one value works in both apps; `Herdr Night`
// is this app's own and the default.

import { DEFAULT_THEME, type Theme } from "../terminal/theme";
import { type Chrome, chromeTokens } from "./chrome";
import { FALLBACK_THEME, parseGhostty } from "./ghostty";

export interface NamedTheme {
  name: string;
  terminal: Theme;
  chrome: Chrome;
}

export const DEFAULT_THEME_NAME = "Herdr Night";

/// Herdr Night's chrome is hand-drawn, not derived: these are styles.css's
/// :root values, which a test keeps equal.
const HERDR_NIGHT: NamedTheme = {
  name: DEFAULT_THEME_NAME,
  terminal: DEFAULT_THEME,
  chrome: {
    scheme: "dark",
    tokens: {
      ink: "#101419",
      peat: "#151a20",
      rule: "#232b34",
      text: "#d8dee9",
      muted: "#7d8896",
      lantern: "#f5d491",
      working: "#82c4ff",
      blocked: "#f28b94",
      done: "#98c379",
      hover: "#1b222a",
      active: "#1f2730",
      raised: "#26303b",
      "rule-strong": "#33404d",
      elbow: "#3b4653",
      gutter: "#141a21",
      faint: "#4b5562",
      bright: "#ffffff",
      team: "#b9a3ff",
      scrim: "rgb(5 8 11 / 0.45)",
      shadow: "#000000",
    },
  },
};

/// herdr-gpui's small hand-authored palettes: background, foreground, ANSI 0..15.
const HAND: Record<string, [number, number, number[]]> = {
  Nord: [
    0x2e3440,
    0xd8dee9,
    [
      0x3b4252, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead, 0x88c0d0, 0xe5e9f0,
      0x4c566a, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead, 0x8fbcbb, 0xeceff4,
    ],
  ],
  Dracula: [
    0x282a36,
    0xf8f8f2,
    [
      0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd, 0xf8f8f2,
      0x6272a4, 0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df, 0xa4ffff, 0xffffff,
    ],
  ],
  "Catppuccin Mocha": [
    0x1e1e2e,
    0xcdd6f4,
    [
      0x45475a, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xbac2de,
      0x585b70, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xf5c2e7, 0x94e2d5, 0xa6adc8,
    ],
  ],
  "Catppuccin Latte": [
    0xeff1f5,
    0x4c4f69,
    [
      0x5c5f77, 0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0xea76cb, 0x179299, 0xacb0be,
      0x6c6f85, 0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0xea76cb, 0x179299, 0xbcc0cc,
    ],
  ],
};

/// The Ghostty files herdr-gpui compiles in, by their upstream file names (see NOTICE.md).
const BUNDLED = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("./ghostty/*", { query: "?raw", import: "default", eager: true }),
  ).map(([path, text]) => [path.slice("./ghostty/".length), text]),
);

/// A theme with its derived chrome.
export function named(name: string, terminal: Theme): NamedTheme {
  return { name, terminal, chrome: chromeTokens(terminal) };
}

const cache = new Map<string, NamedTheme>();

/// A theme that ships with the app, or `undefined` for any other name.
export function builtinTheme(name: string): NamedTheme | undefined {
  if (name === DEFAULT_THEME_NAME) return HERDR_NIGHT;
  const cached = cache.get(name);
  if (cached) return cached;
  let terminal: Theme | undefined;
  if (name === "Default") terminal = FALLBACK_THEME;
  else if (HAND[name]) {
    const [background, foreground, ansi] = HAND[name];
    const palette = [...FALLBACK_THEME.palette];
    palette.splice(0, 16, ...ansi);
    terminal = { background, foreground, cursor: foreground, palette };
  } else if (BUNDLED[name] !== undefined) terminal = parseGhostty(BUNDLED[name]);
  if (!terminal) return undefined;
  const theme = named(name, terminal);
  cache.set(name, theme);
  return theme;
}

/// Every built-in name, Herdr Night first, then as herdr-gpui sorts them.
export const BUILTIN_NAMES: string[] = [
  DEFAULT_THEME_NAME,
  ...["Default", ...Object.keys(HAND), ...Object.keys(BUNDLED)].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  ),
];

/// A `theme` value: one theme, or Ghostty's `light:NAME,dark:NAME`, which
/// follows the system appearance (herdr-gpui's `ThemeName`).
export type ThemeName = { light: string; dark: string };

/// `value` as a light and a dark side (the same name twice for one theme), or
/// `null` for a malformed pair.
export function parseThemeName(value: string): ThemeName | null {
  const trimmed = value.trim();
  const side = (part: string): [boolean, string] | null => {
    const p = part.trim();
    if (p.startsWith("light:")) return [true, p.slice(6).trim()];
    if (p.startsWith("dark:")) return [false, p.slice(5).trim()];
    return null;
  };
  if (!side(trimmed)) return { light: trimmed, dark: trimmed };
  const parts = trimmed.split(",");
  if (parts.length !== 2) return null;
  const [a, b] = parts.map(side);
  if (!a || !b || a[0] === b[0] || !a[1] || !b[1]) return null;
  return a[0] ? { light: a[1], dark: b[1] } : { light: b[1], dark: a[1] };
}

/// The name a `theme` value shows for the system appearance.
export function themeSide(name: ThemeName, light: boolean): string {
  return light ? name.light : name.dark;
}
