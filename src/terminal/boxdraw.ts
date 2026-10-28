// Box-drawing characters drawn as rectangles instead of glyphs. A font's
// `│` is only as tall as its own line height, so with taller cells pane
// borders break into dashes; drawn from the cell's center they join up.

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

/// Light and heavy lines and their corners; rounded corners draw square.
const ARMS: Record<string, number> = {
  "─": LEFT | RIGHT,
  "━": LEFT | RIGHT,
  "│": UP | DOWN,
  "┃": UP | DOWN,
  "┌": DOWN | RIGHT,
  "┏": DOWN | RIGHT,
  "╭": DOWN | RIGHT,
  "┐": DOWN | LEFT,
  "┓": DOWN | LEFT,
  "╮": DOWN | LEFT,
  "└": UP | RIGHT,
  "┗": UP | RIGHT,
  "╰": UP | RIGHT,
  "┘": UP | LEFT,
  "┛": UP | LEFT,
  "╯": UP | LEFT,
  "├": UP | DOWN | RIGHT,
  "┣": UP | DOWN | RIGHT,
  "┤": UP | DOWN | LEFT,
  "┫": UP | DOWN | LEFT,
  "┬": DOWN | LEFT | RIGHT,
  "┳": DOWN | LEFT | RIGHT,
  "┴": UP | LEFT | RIGHT,
  "┻": UP | LEFT | RIGHT,
  "┼": UP | DOWN | LEFT | RIGHT,
  "╋": UP | DOWN | LEFT | RIGHT,
};

const HEAVY = new Set("━┃┏┓┗┛┣┫┳┻╋");

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// The rectangles for `symbol` in a cell at (left, top), or null when it is
/// not a line this module draws.
export function boxBars(symbol: string, left: number, top: number, width: number, height: number): Bar[] | null {
  const arms = ARMS[symbol];
  if (arms === undefined) return null;
  const weight = HEAVY.has(symbol) ? 2 : 1;
  const cx = Math.round(left + width / 2 - weight / 2);
  const cy = Math.round(top + height / 2 - weight / 2);
  const bars: Bar[] = [];
  if (arms & UP) bars.push({ x: cx, y: top, width: weight, height: cy - top + weight });
  if (arms & DOWN) bars.push({ x: cx, y: cy, width: weight, height: top + height - cy });
  if (arms & LEFT) bars.push({ x: left, y: cy, width: cx - left + weight, height: weight });
  if (arms & RIGHT) bars.push({ x: cx, y: cy, width: left + width - cx, height: weight });
  return bars;
}
