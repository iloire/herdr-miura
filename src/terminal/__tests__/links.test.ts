import { describe, expect, it } from "vitest";
import type { Cell, SurfacePane } from "../../protocol";
import { Grid } from "../grid";
import { linkAt } from "../links";

function pane(x: number, width: number, height: number): SurfacePane {
  const rect = { x, y: 0, width, height };
  return {
    pane_id: `p${x}`,
    rect,
    inner_rect: rect,
    focused: true,
    mouse_reporting: false,
    alternate_screen_active: false,
    pixel_width: 0,
    pixel_height: 0,
  };
}

/// A grid from text rows, each padded to `width`, split into the given panes.
function grid(lines: string[], panes?: SurfacePane[]): Grid {
  const width = Math.max(...lines.map((line) => line.length));
  const g = new Grid();
  g.apply({
    boot_id: "boot",
    surface_revision: 1,
    width,
    height: lines.length,
    full: true,
    rows: lines.map((line, y) => ({
      y,
      cells: Array.from(line.padEnd(width), (symbol): Cell => [symbol, 0, 0, 0, false]),
    })),
    cursor: null,
    panes: panes ?? [pane(0, width, lines.length)],
    splits: [],
    popup: null,
  });
  return g;
}

describe("linkAt", () => {
  it("finds the URL under the pointer and its cells", () => {
    const g = grid(["see https://a.dev/x now"]);
    const link = linkAt(g, 10, 0);
    expect(link?.url).toBe("https://a.dev/x");
    expect(link?.cells.map((cell) => cell.x)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(linkAt(g, 1, 0)).toBeNull();
    expect(linkAt(g, 20, 0)).toBeNull();
  });

  it("leaves sentence punctuation and an unopened bracket out", () => {
    expect(linkAt(grid(["(at https://a.dev/x)."]), 6, 0)?.url).toBe("https://a.dev/x");
    expect(linkAt(grid(["https://w.org/A_(b)."]), 3, 0)?.url).toBe("https://w.org/A_(b)");
  });

  it("opens a bare localhost address over http", () => {
    const g = grid(["opened localhost:8080/?pilot=abel in"]);
    expect(linkAt(g, 12, 0)?.url).toBe("http://localhost:8080/?pilot=abel");
  });

  it("follows a URL that wraps onto an indented row", () => {
    const g = grid(["go https://a.dev/lo", "  ng/path end"]);
    const link = linkAt(g, 4, 1);
    expect(link?.url).toBe("https://a.dev/long/path");
    expect(link?.cells.at(-1)).toEqual({ x: 8, y: 1 });
    expect(linkAt(g, 5, 0)?.url).toBe("https://a.dev/long/path");
  });

  it("finds a commit hash in prose", () => {
    const g = grid(["committed as d0de2cf."]);
    expect(linkAt(g, 15, 0)).toEqual({
      commit: "d0de2cf",
      cells: [13, 14, 15, 16, 17, 18, 19].map((x) => ({ x, y: 0 })),
    });
    expect(linkAt(g, 20, 0)).toBeNull();
    expect(linkAt(grid(["0123456789012345678901234567890123456789"]), 3, 0)?.commit).toHaveLength(40);
    const range = grid(["abc1234..def5678"]);
    expect(linkAt(range, 2, 0)?.commit).toBe("abc1234");
    expect(linkAt(range, 12, 0)?.commit).toBe("def5678");
  });

  it("does not take other hex for a commit", () => {
    for (const text of ["src/abc1234/x", "/assets/abc1234", "abc1234.js", "#abcdef12", "id=abc1234", "abc1234-5678", "abcdef", "abc1234g", "ABC1234"]) {
      expect(linkAt(grid([text]), 3, 0)?.commit).toBeUndefined();
    }
  });

  it("lets a URL keep a hash inside it", () => {
    const link = linkAt(grid(["https://a.dev/commit/abc1234 x"]), 24, 0);
    expect(link?.url).toBe("https://a.dev/commit/abc1234");
    expect(link?.commit).toBeUndefined();
  });

  it("does not read across into a neighbouring pane", () => {
    const g = grid(["https://a.dev|tail"], [pane(0, 13, 1), pane(13, 5, 1)]);
    expect(linkAt(g, 3, 0)?.url).toBe("https://a.dev");
  });

  it("finds an absolute path, leaving a sentence's punctuation out", () => {
    const g = grid(["open /Users/me/docs/PLAN.md (commit"]);
    expect(linkAt(g, 10, 0)?.file).toBe("/Users/me/docs/PLAN.md");
    expect(linkAt(g, 28, 0)).toBeNull();
    expect(linkAt(grid(["see /a/b.md."]), 6, 0)?.file).toBe("/a/b.md");
  });

  it("finds relative paths and bare file names", () => {
    expect(linkAt(grid(["src/app/queue.ts"]), 5, 0)?.file).toBe("src/app/queue.ts");
    expect(linkAt(grid(["../x/y.ts"]), 1, 0)?.file).toBe("../x/y.ts");
    expect(linkAt(grid(["~/notes/a.md"]), 0, 0)?.file).toBe("~/notes/a.md");
    expect(linkAt(grid(["a CHANGELOG.md entry"]), 4, 0)?.file).toBe("CHANGELOG.md");
    expect(linkAt(grid([".env.local"]), 3, 0)?.file).toBe(".env.local");
  });

  it("leaves a line number out of the path", () => {
    const g = grid(["src/App.tsx:409"]);
    expect(linkAt(g, 3, 0)?.file).toBe("src/App.tsx");
    expect(linkAt(g, 13, 0)).toBeNull();
  });

  it("finds a path that wraps rows, its cells included", () => {
    const g = grid(["see /Users/me/plans/", "    weekly/PLAN.md  "]);
    const link = linkAt(g, 8, 1);
    expect(link?.file).toBe("/Users/me/plans/weekly/PLAN.md");
    expect(link?.cells).toHaveLength(30);
  });

  it("takes plain words and numbers for no path", () => {
    const g = grid(["Hello there, version 3.5 end."]);
    expect(linkAt(g, 2, 0)).toBeNull();
    expect(linkAt(g, 22, 0)).toBeNull();
    expect(linkAt(g, 26, 0)).toBeNull();
  });

  it("finds a pasted image's number, on the whole of its label", () => {
    const g = grid(["> [Image #12] what is this"]);
    expect(linkAt(g, 2, 0)).toMatchObject({ image: 12 });
    expect(linkAt(g, 12, 0)?.image).toBe(12);
    expect(linkAt(g, 12, 0)?.cells).toHaveLength(11);
    expect(linkAt(g, 13, 0)).toBeNull();
  });

  it("prefers a URL and a commit to a path", () => {
    expect(linkAt(grid(["https://a.dev/x/y.md"]), 16, 0)?.url).toBe("https://a.dev/x/y.md");
    expect(linkAt(grid(["see d0de2cf"]), 6, 0)?.commit).toBe("d0de2cf");
  });
});
