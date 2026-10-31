import { describe, expect, it } from "vitest";
import { absolutePath, canOpen } from "../fileActions";
import type { ChangedFile } from "../store";

const file = (path: string, mark: string): ChangedFile => ({ path, mark, additions: null, deletions: null });

describe("absolutePath", () => {
  it("joins the checkout and the path once", () => {
    expect(absolutePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(absolutePath("/repo/", "a.ts")).toBe("/repo/a.ts");
  });
});

describe("canOpen", () => {
  it("offers a file that is on disk", () => {
    for (const mark of ["M", "A", "R", "?"]) expect(canOpen(file("a.ts", mark))).toBe(true);
  });

  it("does not offer a deleted file or an untracked folder", () => {
    expect(canOpen(file("a.ts", "D"))).toBe(false);
    expect(canOpen(file("dir/", "?"))).toBe(false);
  });
});
