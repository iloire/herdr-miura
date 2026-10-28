// Cell color decoding, ported from herdr-gpui's `terminal.rs` (`color`,
// `cell_colors`). Colors are 0xRRGGBB numbers until the painter needs CSS.

export const BOLD = 1;
export const DIM = 1 << 1;
export const ITALIC = 1 << 2;
export const UNDERLINE = 1 << 3;
export const REVERSED = 1 << 6;
export const HIDDEN = 1 << 7;
export const STRIKETHROUGH = 1 << 8;

export interface Theme {
  foreground: number;
  background: number;
  cursor: number;
  /// 256 entries: 16 ANSI colors, the 6x6x6 cube, then 24 grays.
  palette: number[];
}

const ANSI = [
  0x1d2129, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xd8dee9,
  0x5c6370, 0xf28b94, 0xb5e890, 0xf5d491, 0x82c4ff, 0xdc9cf0, 0x7fd4de, 0xffffff,
];

export function xtermPalette(ansi: number[]): number[] {
  const palette = [...ansi];
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++) palette.push((level(r) << 16) | (level(g) << 8) | level(b));
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push((v << 16) | (v << 8) | v);
  }
  return palette;
}

export const DEFAULT_THEME: Theme = {
  foreground: 0xd8dee9,
  background: 0x101419,
  cursor: 0xf5d491,
  palette: xtermPalette(ANSI),
};

/// Named 0..=16 (0 is the default, 1..=16 the ANSI colors), indexed
/// 0x010000XX, RGB 0x02RRGGBB.
export function color(value: number, fallback: number, theme: Theme): number {
  const low = value & 0xff;
  switch (value >>> 24) {
    case 0:
      return low >= 1 && low <= 16 ? theme.palette[low - 1] : fallback;
    case 1:
      return theme.palette[low];
    case 2:
      return value & 0xffffff;
    default:
      return fallback;
  }
}

export function cellColors(
  fgValue: number,
  bgValue: number,
  modifier: number,
  theme: Theme,
): [number, number] {
  let fg = color(fgValue, theme.foreground, theme);
  let bg = color(bgValue, theme.background, theme);
  if (modifier & REVERSED) [fg, bg] = [bg, fg];
  if (modifier & DIM) fg = ((fg & 0xfefefe) >>> 1) + ((bg & 0xfefefe) >>> 1);
  if (modifier & HIDDEN) fg = bg;
  return [fg, bg];
}

export function css(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}
