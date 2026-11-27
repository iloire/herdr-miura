import type { Rect } from "../protocol";
import type { Grid } from "./grid";

export interface Point {
  x: number;
  y: number;
}

/// A text selection in one pane, in grid cells. It runs like text, from
/// `anchor` (where the press was) to `head` (where the pointer is), and stays
/// inside the pane's `rect` so a drag never reaches the pane beside it.
export interface Selection {
  paneId: string;
  rect: Rect;
  anchor: Point;
  head: Point;
}

export function clampTo(rect: Rect, point: Point): Point {
  return {
    x: Math.min(rect.x + rect.width - 1, Math.max(rect.x, point.x)),
    y: Math.min(rect.y + rect.height - 1, Math.max(rect.y, point.y)),
  };
}

/// Start and end in reading order.
function ordered({ anchor, head }: Selection): [Point, Point] {
  return anchor.y < head.y || (anchor.y === head.y && anchor.x <= head.x) ? [anchor, head] : [head, anchor];
}

export function isEmpty(selection: Selection): boolean {
  return selection.anchor.x === selection.head.x && selection.anchor.y === selection.head.y;
}

/// The selected columns of row `y`, as [first, last], or null.
export function rowSpan(selection: Selection, y: number): [number, number] | null {
  const [start, end] = ordered(selection);
  if (y < start.y || y > end.y) return null;
  const left = selection.rect.x;
  const right = selection.rect.x + selection.rect.width - 1;
  return [y === start.y ? start.x : left, y === end.y ? end.x : right];
}

/// The selected text: each row without its trailing blanks, rows joined by
/// newlines. A wide character's continuation cell adds nothing.
export function selectionText(grid: Grid, selection: Selection): string {
  const [start, end] = ordered(selection);
  const lines: string[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const span = rowSpan(selection, y);
    if (!span) continue;
    let line = "";
    for (let x = span[0]; x <= span[1]; x++) {
      const [symbol, , , , skip] = grid.cell(x, y);
      if (!skip) line += symbol || " ";
    }
    lines.push(line.trimEnd());
  }
  return lines.join("\n");
}

const WORD = /[^\s"'`()[\]{}<>│|,;]/u;

/// The word under `point` for a double-click: a run of cells that are not
/// blanks, quotes, brackets or separators, so a path or URL comes whole.
export function wordAt(grid: Grid, rect: Rect, point: Point): [Point, Point] | null {
  const inWord = (x: number) => {
    const [symbol, , , , skip] = grid.cell(x, point.y);
    return skip || WORD.test(symbol);
  };
  if (!inWord(point.x)) return null;
  let left = point.x;
  let right = point.x;
  while (left > rect.x && inWord(left - 1)) left--;
  while (right < rect.x + rect.width - 1 && inWord(right + 1)) right++;
  return [
    { x: left, y: point.y },
    { x: right, y: point.y },
  ];
}
