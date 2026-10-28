import type { Cell, Cursor, Popup } from "../protocol";
import { boxBars } from "./boxdraw";
import type { Grid } from "./grid";
import { BOLD, ITALIC, STRIKETHROUGH, UNDERLINE, cellColors, css, type Theme } from "./theme";

export interface Metrics {
  /// CSS pixels.
  cellWidth: number;
  cellHeight: number;
  fontSize: number;
  fontFamily: string;
}

export const FONT_FAMILY = `"JetBrains Mono", "SF Mono", Menlo, "DejaVu Sans Mono", monospace`;

export function measure(fontSize: number, lineHeight = 1.4, fontFamily = FONT_FAMILY): Metrics {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { cellWidth: fontSize * 0.6, cellHeight: fontSize * lineHeight, fontSize, fontFamily };
  ctx.font = `${fontSize}px ${fontFamily}`;
  return {
    cellWidth: ctx.measureText("M").width,
    cellHeight: Math.round(fontSize * lineHeight),
    fontSize,
    fontFamily,
  };
}

/// Paints a `Grid` onto a canvas, row by row. Only rows `paint` is handed are
/// redrawn; a popup, being small and on top, is redrawn whole every frame.
export class Painter {
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    public metrics: Metrics,
    public theme: Theme,
  ) {}

  /// Matches the backing store to the grid. Returns true when it was resized,
  /// which clears it, so the caller repaints everything.
  layout(grid: Grid): boolean {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(grid.width * this.metrics.cellWidth * dpr);
    const height = Math.round(grid.height * this.metrics.cellHeight * dpr);
    if (this.canvas.width === width && this.canvas.height === height && this.dpr === dpr) return false;
    this.dpr = dpr;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${grid.width * this.metrics.cellWidth}px`;
    this.canvas.style.height = `${grid.height * this.metrics.cellHeight}px`;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    return true;
  }

  paint(grid: Grid, rows: Iterable<number>, focused: boolean): void {
    const all = this.layout(grid);
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textBaseline = "middle";
    // A popup can move or shrink between frames, so nothing under it is kept.
    const targets = all || grid.popup ? Array.from({ length: grid.height }, (_, y) => y) : rows;
    for (const y of targets) {
      this.paintRow(ctx, y, 0, 0, grid.width, (x) => grid.cell(x, y));
    }
    if (grid.cursor && !grid.popup) this.paintCursor(ctx, grid.cursor, 0, 0, grid.cell(grid.cursor.x, grid.cursor.y), focused);
    if (grid.popup) this.paintPopup(ctx, grid, grid.popup, focused);
  }

  private paintRow(
    ctx: CanvasRenderingContext2D,
    y: number,
    originX: number,
    originY: number,
    width: number,
    cellAt: (x: number) => Cell,
  ): void {
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const top = originY + y * ch;
    ctx.fillStyle = css(this.theme.background);
    ctx.fillRect(originX, top, width * cw, ch);
    for (let x = 0; x < width; x++) {
      const [symbol, fgValue, bgValue, modifier, skip] = cellAt(x);
      const [fg, bg] = cellColors(fgValue, bgValue, modifier, this.theme);
      const left = originX + x * cw;
      if (bg !== this.theme.background) {
        ctx.fillStyle = css(bg);
        // Slight overdraw hides seams between neighbors at fractional widths.
        ctx.fillRect(left, top, cw + 0.5, ch);
      }
      // A wide character's continuation cell has its glyph drawn by the
      // cell before it, but still paints its own decorations.
      const bars = skip ? null : boxBars(symbol, left, top, cw, ch);
      if (bars) {
        ctx.fillStyle = css(fg);
        for (const bar of bars) ctx.fillRect(bar.x, bar.y, bar.width, bar.height);
      } else if (!skip && symbol !== " " && symbol !== "") {
        ctx.fillStyle = css(fg);
        ctx.font = `${modifier & ITALIC ? "italic " : ""}${modifier & BOLD ? "bold " : ""}${this.metrics.fontSize}px ${this.metrics.fontFamily}`;
        ctx.fillText(symbol, left, top + ch / 2);
      }
      if (modifier & (UNDERLINE | STRIKETHROUGH)) {
        ctx.fillStyle = css(fg);
        if (modifier & UNDERLINE) ctx.fillRect(left, top + ch - 2, cw + 0.5, 1);
        if (modifier & STRIKETHROUGH) ctx.fillRect(left, top + ch / 2, cw + 0.5, 1);
      }
    }
  }

  private paintCursor(
    ctx: CanvasRenderingContext2D,
    cursor: Cursor,
    originX: number,
    originY: number,
    under: Cell,
    focused: boolean,
  ): void {
    if (!cursor.visible) return;
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const left = originX + cursor.x * cw;
    const top = originY + cursor.y * ch;
    ctx.fillStyle = css(this.theme.cursor);
    ctx.strokeStyle = css(this.theme.cursor);
    if (!focused) {
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, cw - 1, ch - 1);
    } else if (cursor.shape === 3 || cursor.shape === 4) {
      ctx.fillRect(left, top + ch - 2, cw, 2);
    } else if (cursor.shape === 5 || cursor.shape === 6) {
      ctx.fillRect(left, top, 2, ch);
    } else {
      ctx.fillRect(left, top, cw, ch);
      const [symbol] = under;
      if (symbol && symbol !== " ") {
        ctx.fillStyle = css(this.theme.background);
        ctx.font = `${this.metrics.fontSize}px ${this.metrics.fontFamily}`;
        ctx.fillText(symbol, left, top + ch / 2);
      }
    }
  }

  private paintPopup(ctx: CanvasRenderingContext2D, grid: Grid, popup: Popup, focused: boolean): void {
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const { x, y } = popupOrigin(grid, popup, cw, ch);
    const width = popup.cols;
    const height = popup.rows.length;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 24;
    ctx.fillStyle = css(this.theme.background);
    ctx.fillRect(x, y, width * cw, height * ch);
    ctx.restore();
    for (const row of popup.rows) {
      this.paintRow(ctx, row.y, x, y, width, (column) => row.cells[column] ?? [" ", 0, 0, 0, false]);
    }
    if (popup.cursor) {
      const row = popup.rows[popup.cursor.y];
      this.paintCursor(ctx, popup.cursor, x, y, row?.cells[popup.cursor.x] ?? [" ", 0, 0, 0, false], focused);
    }
  }
}

/// Where a popup sits over the panes: centered, in CSS pixels.
export function popupOrigin(grid: Grid, popup: Popup, cellWidth: number, cellHeight: number) {
  return {
    x: Math.floor((Math.max(0, grid.width - popup.cols) * cellWidth) / 2),
    y: (Math.max(0, grid.height - popup.rows.length) * cellHeight) / 2,
  };
}
