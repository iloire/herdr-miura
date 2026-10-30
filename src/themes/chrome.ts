// The chrome's colors (every CSS token on :root) from a terminal theme, ported
// from herdr-gpui's `Theme` helpers: surfaces are blends of the background
// toward the foreground, and status colors come from the palette, nudged only
// when they would not read on the chrome.

import { css, type Theme } from "../terminal/theme";
import { MARK_RATIO, TEXT_RATIO, ink, ratio } from "./contrast";

/// The CSS custom properties a theme sets, without their `--`.
export const TOKENS = [
  "ink",
  "peat",
  "rule",
  "text",
  "muted",
  "lantern",
  "working",
  "blocked",
  "done",
  "hover",
  "active",
  "raised",
  "rule-strong",
  "elbow",
  "gutter",
  "faint",
  "bright",
  "team",
  "scrim",
  "shadow",
] as const;

export type Token = (typeof TOKENS)[number];

export interface Chrome {
  tokens: Record<Token, string>;
  scheme: "light" | "dark";
}

/// `percent` of `over` blended onto `base`, per channel (herdr-gpui's `mix`).
export function mix(base: number, over: number, percent: number): number {
  const channel = (shift: number) => {
    const b = (base >> shift) & 255;
    const o = (over >> shift) & 255;
    return Math.floor((b * (100 - percent) + o * percent) / 100);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/// `color` moved just far enough to read as words on a chrome that has `tokens`:
/// on the background, the sidebar and a selected row. A solid fill of it holds
/// words in `--ink` just as well, the pair being the same two colors.
export function legible(color: number, tokens: Record<Token, string>): number {
  const surfaces = [tokens.ink, tokens.peat, tokens.active].map((token) => parseInt(token.slice(1), 16));
  return ink(color, surfaces, TEXT_RATIO);
}

/// Dark when white text would read better on the background than black.
export function isDark(background: number): boolean {
  return ratio(background, 0xffffff) >= ratio(background, 0x000000);
}

/// Every chrome token for `theme`. Terminal colors are only read, never
/// changed: the nudge applies to the chrome's own words and marks.
export function chromeTokens(theme: Theme): Chrome {
  const { background: bg, foreground: fg, palette } = theme;
  const dark = isDark(bg);
  const blend = (percent: number) => mix(bg, fg, percent);
  // The bars sit barely off the terminal: a hover or a selection separates
  // things, not a change of surface.
  const surface = blend(2);
  const active = blend(12);
  const surfaces = [bg, surface, active];
  // The status colors are words as often as marks, so they read as words.
  const word = (color: number) => css(ink(color, surfaces, TEXT_RATIO));
  // The cursor is the theme's own accent unless it merely repeats the text.
  const lantern = theme.cursor !== fg ? theme.cursor : palette[3];
  const scrim = mix(bg, 0x000000, 70);
  return {
    scheme: dark ? "dark" : "light",
    tokens: {
      ink: css(bg),
      peat: css(surface),
      rule: css(blend(7)),
      text: css(fg),
      muted: word(blend(55)),
      lantern: word(lantern),
      working: word(palette[4]),
      blocked: word(palette[1]),
      done: word(palette[2]),
      hover: css(blend(8)),
      active: css(active),
      raised: css(blend(16)),
      "rule-strong": css(blend(20)),
      elbow: css(blend(24)),
      gutter: css(blend(3)),
      // Line numbers only: they can sit back, but not vanish.
      faint: css(ink(blend(35), surfaces, MARK_RATIO)),
      bright: css(mix(fg, dark ? 0xffffff : 0x000000, 50)),
      team: word(palette[5]),
      scrim: `rgb(${(scrim >> 16) & 255} ${(scrim >> 8) & 255} ${scrim & 255} / 0.45)`,
      shadow: "#000000",
    },
  };
}
