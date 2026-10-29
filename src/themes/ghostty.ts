// Ghostty theme files (`palette = N=#rrggbb`, `background`, `foreground`,
// `cursor-color`), ported from herdr-gpui's `Theme::parse_ghostty`, so a file
// reads the same in both apps.

import { type Theme, xtermPalette } from "../terminal/theme";

/// What a file falls back to for anything it leaves out: herdr-gpui's
/// `Theme::default`, the VGA colors over Herdr's own background.
const VGA = [
  0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
  0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
];

export const FALLBACK_THEME: Theme = {
  background: 0x101419,
  foreground: 0xd8dee9,
  cursor: 0xd8dee9,
  palette: xtermPalette(VGA),
};

/// A line the parser refused, numbered from 1.
export class ThemeParseError extends Error {
  constructor(
    readonly line: number,
    readonly key: string,
    reason: string,
  ) {
    super(`line ${line} (${key}): ${reason}`);
  }
}

/// `#rrggbb` or `rrggbb`, nothing else: no names, no shorthand.
function hex(value: string): number | null {
  const digits = value.startsWith("#") ? value.slice(1) : value;
  return /^[0-9a-fA-F]{6}$/.test(digits) ? parseInt(digits, 16) : null;
}

/// The theme `text` describes. Comments, blank lines and keys that are not
/// colors are skipped (never includes or commands); a color that does not
/// parse refuses the whole file, as herdr-gpui does.
export function parseGhostty(text: string): Theme {
  const theme = { ...FALLBACK_THEME, palette: [...FALLBACK_THEME.palette] };
  let cursorSet = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const equals = line.indexOf("=");
    const key = (equals < 0 ? line : line.slice(0, equals)).trim();
    const value = equals < 0 ? "" : line.slice(equals + 1).trim();
    const fail = (reason: string) => new ThemeParseError(index + 1, key, reason);
    const color = (value: string) => {
      const parsed = hex(value);
      if (parsed === null) throw fail(`\`${value}\` is not a #rrggbb color`);
      return parsed;
    };
    switch (key) {
      case "background":
        theme.background = color(value);
        break;
      case "foreground":
        theme.foreground = color(value);
        break;
      case "cursor-color":
        theme.cursor = color(value);
        cursorSet = true;
        break;
      case "palette": {
        const split = value.indexOf("=");
        if (split < 0) throw fail("expected palette = N=#rrggbb");
        const slot = value.slice(0, split).trim();
        if (!/^\d+$/.test(slot)) throw fail(`\`${slot}\` is not a palette index`);
        const n = Number(slot);
        if (n >= 256) throw fail(`palette index ${n} is past 255`);
        theme.palette[n] = color(value.slice(split + 1).trim());
        break;
      }
    }
  });
  if (!cursorSet) theme.cursor = theme.foreground;
  return theme;
}
