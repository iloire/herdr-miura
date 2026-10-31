import type { Grid } from "./grid";

/// A URL or commit hash found in the grid, with the cells it covers (it may
/// wrap rows).
export interface Link {
  url?: string;
  commit?: string;
  cells: { x: number; y: number }[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s<>"'`]*)?/g;

/// What could be a commit: a lone run of hex digits, not part of a path, a
/// file name, a UUID or a color. Only Git can tell whether it is one.
const COMMIT_PATTERN = /(?<![\w/#=-]|\w\.)[0-9a-f]{7,64}(?![\w/-]|\.\w)/g;

/// Prose punctuation that ends a sentence rather than the URL.
const TRAILING = /[.,;:!?'"*]+$/;

/// Drops trailing punctuation, and a closing bracket the URL never opened.
function trim(text: string): string {
  let url = text.replace(TRAILING, "");
  for (const [open, close] of ["()", "[]", "{}"]) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
      url = url.slice(0, -1).replace(TRAILING, "");
    }
  }
  return url;
}

/// The URL or commit hash under a cell, if any. Text is read only within the pane holding
/// the cell, so a neighbouring pane's text never joins it, and a row whose
/// last column is filled continues onto the next one, as a wrapped URL does.
export function linkAt(grid: Grid, column: number, row: number): Link | null {
  const pane = grid.paneAt(column, row);
  if (!pane) return null;
  const { x: left, y: top, width, height } = pane.inner_rect;
  if (column < left || column >= left + width || row < top || row >= top + height) return null;
  const right = left + width - 1;
  const filled = (y: number) => grid.cell(right, y)[0].trim() !== "";

  let first = row;
  while (first > top && filled(first - 1)) first--;
  let last = row;
  while (last < top + height - 1 && filled(last)) last++;

  // The logical line's text, and for each UTF-16 unit the cell it came from.
  let text = "";
  const origin: { x: number; y: number }[] = [];
  for (let y = first; y <= last; y++) {
    let x = left;
    // A continuation row's indent is the wrapper's, not part of the line.
    if (y > first) while (x < right && grid.cell(x, y)[0] === " ") x++;
    for (; x <= right; x++) {
      const [symbol, , , , skip] = grid.cell(x, y);
      if (skip) continue;
      const unit = symbol === "" ? " " : symbol;
      text += unit;
      for (let i = 0; i < unit.length; i++) origin.push({ x, y });
    }
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trim(match[0]);
    const start = match.index;
    const covered = origin.slice(start, start + url.length);
    if (!covered.some((cell) => cell.x === column && cell.y === row)) continue;
    const cells = covered.filter((cell, i) => i === 0 || cell !== covered[i - 1]);
    return { url: url.startsWith("http") ? url : `http://${url}`, cells };
  }
  for (const match of text.matchAll(COMMIT_PATTERN)) {
    const covered = origin.slice(match.index, match.index + match[0].length);
    if (covered.some((cell) => cell.x === column && cell.y === row)) return { commit: match[0], cells: covered };
  }
  return null;
}
