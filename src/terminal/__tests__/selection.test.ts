import { describe, expect, it } from "vitest";
import type { Cell } from "../../protocol";
import { Grid } from "../grid";
import { clampTo, rowSpan, selectionText, wordAt, type Selection } from "../selection";

function gridOf(lines: string[]): Grid {
  const grid = new Grid();
  grid.width = lines[0].length;
  grid.height = lines.length;
  grid.cells = lines.flatMap((line) => [...line].map((symbol): Cell => [symbol, 0, 0, 0, false]));
  return grid;
}

const rect = { x: 0, y: 0, width: 8, height: 3 };
const sel = (anchor: [number, number], head: [number, number]): Selection => ({
  paneId: "p",
  rect,
  anchor: { x: anchor[0], y: anchor[1] },
  head: { x: head[0], y: head[1] },
});

describe("selection", () => {
  const grid = gridOf(["ab cd   ", "efgh    ", "ij      "]);

  it("runs like text across rows and drops trailing blanks", () => {
    expect(selectionText(grid, sel([3, 0], [1, 2]))).toBe("cd\nefgh\nij");
  });

  it("reads the same dragged backwards", () => {
    expect(selectionText(grid, sel([1, 2], [3, 0]))).toBe("cd\nefgh\nij");
  });

  it("spans a middle row whole, the end rows from and to the points", () => {
    const selection = sel([3, 0], [1, 2]);
    expect(rowSpan(selection, 0)).toEqual([3, 7]);
    expect(rowSpan(selection, 1)).toEqual([0, 7]);
    expect(rowSpan(selection, 2)).toEqual([0, 1]);
  });

  it("stays inside its pane", () => {
    expect(clampTo({ x: 2, y: 1, width: 3, height: 2 }, { x: 9, y: 0 })).toEqual({ x: 4, y: 1 });
  });

  it("skips a wide character's continuation cell", () => {
    const wide = gridOf(["界_ x"]);
    wide.cells[1] = ["", 0, 0, 0, true];
    expect(selectionText(wide, { ...sel([0, 0], [3, 0]), rect: { x: 0, y: 0, width: 4, height: 1 } })).toBe("界 x");
  });

  it("takes a path whole on a double-click", () => {
    const line = gridOf(["see ~/a/b.ts:4 ok"]);
    const word = wordAt(line, { x: 0, y: 0, width: 17, height: 1 }, { x: 7, y: 0 });
    expect(word?.map((point) => point.x)).toEqual([4, 13]);
    expect(wordAt(line, { x: 0, y: 0, width: 17, height: 1 }, { x: 3, y: 0 })).toBeNull();
  });
});
