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

/// A grid from text rows, each padded to `width`, split into the given panes,
/// with `links` giving cells an OSC 8 target by `"x,y"`.
function grid(lines: string[], panes?: SurfacePane[], links: Record<string, string> = {}): Grid {
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
      cells: Array.from(line.padEnd(width), (symbol, x): Cell => {
        const link = links[`${x},${y}`];
        return link ? [symbol, 0, 0, 0, false, link] : [symbol, 0, 0, 0, false];
      }),
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

  it("opens a program's own link rather than what its text looks like", () => {
    const linked = (from: number, to: number, href: string) =>
      Object.fromEntries(Array.from({ length: to - from }, (_, i) => [`${from + i},0`, href]));
    const g = grid(["sign up at improvmx.com and"], undefined, linked(11, 23, "https://improvmx.com/"));
    const link = linkAt(g, 14, 0);
    expect(link?.url).toBe("https://improvmx.com/");
    expect(link?.file).toBeUndefined();
    expect(link?.cells.map((cell) => cell.x)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);

    const file = grid(["see notes here"], undefined, linked(4, 9, "file://mac/Users/me/My%20notes.md"));
    expect(linkAt(file, 5, 0)?.file).toBe("/Users/me/My notes.md");

    // A scheme the app cannot open falls back to the text.
    const other = grid(["run a.md now"], undefined, linked(4, 8, "x-custom://thing"));
    expect(linkAt(other, 5, 0)?.file).toBe("a.md");
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

  describe("a `! cmd` to run in Claude Code's prompt", () => {
    /// Rows of text, with `colors` marking each cell drawn as code by a `c`.
    function painted(lines: string[], colors: string[]): Grid {
      const g = grid(lines);
      lines.forEach((_, y) => {
        for (let x = 0; x < g.width; x++) {
          const cell = g.cell(x, y);
          g.cells[y * g.width + x] = [cell[0], colors[y]?.[x] === "c" ? 4 : 0, 0, 0, false];
        }
      });
      return g;
    }

    it("takes the command in code colour, without the `!` or the full stop", () => {
      const g = painted(["then run ! vercel firewall publish."], ["         ccccccccccccccccccccccccc "]);
      const link = linkAt(g, 14, 0);
      expect(link?.command).toBe("vercel firewall publish");
      expect(link?.cells[0]).toEqual({ x: 9, y: 0 });
      expect(link?.cells.at(-1)).toEqual({ x: 33, y: 0 });
      expect(linkAt(g, 9, 0)?.command).toBe("vercel firewall publish");
      expect(linkAt(g, 34, 0)).toBeNull();
    });

    it("follows the command across Claude Code's word wrap", () => {
      const g = painted(["live, run !   ", "  vercel firewall ls to"], ["          c   ", "  ccccccccccccccccccc   "]);
      expect(linkAt(g, 4, 1)?.command).toBe("vercel firewall ls");
      expect(linkAt(g, 10, 0)?.command).toBe("vercel firewall ls");
      expect(linkAt(g, 22, 1)).toBeNull();
    });

    it("leaves a `!` in prose alone", () => {
      expect(linkAt(painted(["Done! next"], ["          "]), 4, 0)).toBeNull();
      expect(linkAt(painted(["Wow ! look"], ["          "]), 4, 0)).toBeNull();
    });

    it("wins over a path inside the command", () => {
      expect(linkAt(painted(["run ! cat src/a.ts"], ["    cccccccccccccc"]), 12, 0)?.command).toBe("cat src/a.ts");
    });
  });
});
