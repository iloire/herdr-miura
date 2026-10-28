import type { Cell, Cursor, FrameUpdate, Popup, Split, SurfacePane } from "../protocol";

const BLANK: Cell = [" ", 0, 0, 0, false];

/// The daemon's composed surface for the focused tab, rebuilt from the
/// bridge's row updates. `apply` returns the rows the painter must redraw.
export class Grid {
  bootId = "";
  revision = 0;
  width = 0;
  height = 0;
  cells: Cell[] = [];
  cursor: Cursor | null = null;
  panes: SurfacePane[] = [];
  splits: Split[] = [];
  popup: Popup | null = null;

  apply(update: FrameUpdate): Set<number> {
    const dirty = new Set<number>();
    if (update.full || update.width !== this.width || update.height !== this.height) {
      this.width = update.width;
      this.height = update.height;
      this.cells = new Array<Cell>(update.width * update.height).fill(BLANK);
      for (let y = 0; y < update.height; y++) dirty.add(y);
    }
    for (const row of update.rows) {
      if (row.y >= this.height) continue;
      const start = row.y * this.width;
      for (let x = 0; x < Math.min(row.cells.length, this.width); x++) {
        this.cells[start + x] = row.cells[x];
      }
      dirty.add(row.y);
    }
    // The cursor's old and new rows repaint so it never leaves a trail.
    if (this.cursor) dirty.add(this.cursor.y);
    if (update.cursor) dirty.add(update.cursor.y);
    // A popup that closes uncovers rows nothing else marks dirty.
    if (this.popup && !update.popup) for (let y = 0; y < this.height; y++) dirty.add(y);
    this.bootId = update.boot_id;
    this.revision = update.surface_revision;
    this.cursor = update.cursor;
    this.panes = update.panes;
    this.splits = update.splits;
    this.popup = update.popup;
    return dirty;
  }

  cell(x: number, y: number): Cell {
    return this.cells[y * this.width + x] ?? BLANK;
  }

  paneAt(column: number, row: number): SurfacePane | undefined {
    return this.panes.find((pane) => inRect(pane.rect, column, row));
  }

  splitAt(column: number, row: number): Split | undefined {
    if (this.popup) return undefined;
    return this.splits.find((split) => inRect(split.hit_rect, column, row));
  }
}

export function inRect(
  rect: { x: number; y: number; width: number; height: number },
  column: number,
  row: number,
): boolean {
  return (
    column >= rect.x && column < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height
  );
}
