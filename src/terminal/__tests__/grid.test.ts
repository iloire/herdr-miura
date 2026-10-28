import { describe, expect, it } from "vitest";
import type { Cell, FrameUpdate } from "../../protocol";
import { Grid } from "../grid";

const cell = (symbol: string): Cell => [symbol, 0, 0, 0, false];

function frame(over: Partial<FrameUpdate>): FrameUpdate {
  return {
    boot_id: "boot",
    surface_revision: 1,
    width: 2,
    height: 2,
    full: true,
    rows: [],
    cursor: null,
    panes: [],
    splits: [],
    popup: null,
    ...over,
  };
}

describe("Grid", () => {
  it("rebuilds on a full frame", () => {
    const grid = new Grid();
    const dirty = grid.apply(frame({ rows: [{ y: 1, cells: [cell("a"), cell("b")] }] }));
    expect([...dirty].sort()).toEqual([0, 1]);
    expect(grid.cell(1, 1)[0]).toBe("b");
    expect(grid.cell(0, 0)[0]).toBe(" ");
  });

  it("patches only the rows sent", () => {
    const grid = new Grid();
    grid.apply(frame({ rows: [{ y: 0, cells: [cell("a"), cell("b")] }] }));
    const dirty = grid.apply(frame({ full: false, rows: [{ y: 1, cells: [cell("c"), cell("d")] }] }));
    expect([...dirty]).toEqual([1]);
    expect(grid.cell(0, 0)[0]).toBe("a");
    expect(grid.cell(0, 1)[0]).toBe("c");
  });

  it("repaints the row a cursor leaves", () => {
    const grid = new Grid();
    grid.apply(frame({ cursor: { x: 0, y: 0, visible: true, shape: 0 } }));
    const dirty = grid.apply(frame({ full: false, cursor: { x: 0, y: 1, visible: true, shape: 0 } }));
    expect([...dirty].sort()).toEqual([0, 1]);
  });

  it("ignores rows past the grid", () => {
    const grid = new Grid();
    expect(() => grid.apply(frame({ rows: [{ y: 9, cells: [cell("x")] }] }))).not.toThrow();
  });

  it("finds panes and splits by cell", () => {
    const grid = new Grid();
    const rect = { x: 0, y: 0, width: 1, height: 2 };
    grid.apply(
      frame({
        panes: [{ pane_id: "p", rect, inner_rect: rect, focused: true, mouse_reporting: false, alternate_screen_active: false, pixel_width: 0, pixel_height: 0 }],
        splits: [{ direction: "Horizontal", pos: 1, area: { x: 0, y: 0, width: 2, height: 2 }, hit_rect: { x: 1, y: 0, width: 1, height: 2 }, path: [] }],
      }),
    );
    expect(grid.paneAt(0, 1)?.pane_id).toBe("p");
    expect(grid.paneAt(1, 1)).toBeUndefined();
    expect(grid.splitAt(1, 0)?.direction).toBe("Horizontal");
  });
});
