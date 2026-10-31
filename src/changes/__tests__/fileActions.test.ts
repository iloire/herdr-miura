import { describe, expect, it } from "vitest";
import { absolutePath, canCommit, canOpen, canTick, keepListed, tickState, toggleAll } from "../fileActions";
import type { ChangedFile, CheckoutChanges } from "../store";

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

describe("canCommit", () => {
  const checkout = (fields: Partial<CheckoutChanges>) =>
    ({ branch: "main", born: true, operation: null, ...fields }) as CheckoutChanges;

  it("offers a branch with a commit and nothing under way", () => {
    expect(canCommit(checkout({}))).toBe(true);
  });

  it("does not offer a detached HEAD, an unborn branch, or a merge or rebase", () => {
    expect(canCommit(checkout({ branch: null }))).toBe(false);
    expect(canCommit(checkout({ born: false }))).toBe(false);
    expect(canCommit(checkout({ operation: "rebase" }))).toBe(false);
    expect(canCommit(checkout({ operation: "merge" }))).toBe(false);
  });
});

describe("canTick", () => {
  it("leaves out a conflict", () => {
    expect(canTick(file("a", "M"))).toBe(true);
    expect(canTick(file("a", "U"))).toBe(false);
  });
});

describe("keepListed", () => {
  it("forgets a file that left the list", () => {
    expect([...keepListed(new Set(["a", "b"]), [file("b", "M")])]).toEqual(["b"]);
  });

  it("answers with the same set when nothing left", () => {
    const ticks = new Set(["a"]);
    expect(keepListed(ticks, [file("a", "M"), file("b", "M")])).toBe(ticks);
  });
});

describe("tickState", () => {
  const files = [file("a", "M"), file("b", "?")];

  it("tells none, some and all apart", () => {
    expect(tickState(new Set(), files)).toBe("none");
    expect(tickState(new Set(["a"]), files)).toBe("some");
    expect(tickState(new Set(["a", "b"]), files)).toBe("all");
  });

  it("does not hold a conflict against all", () => {
    expect(tickState(new Set(["a"]), [file("a", "M"), file("c", "U")])).toBe("all");
  });

  it("reads an empty list as none", () => {
    expect(tickState(new Set(), [])).toBe("none");
  });
});

describe("toggleAll", () => {
  const files = [file("a", "M"), file("b", "?"), file("c", "U")];

  it("ticks everything but a conflict from none or some", () => {
    expect([...toggleAll(new Set(), files)]).toEqual(["a", "b"]);
    expect([...toggleAll(new Set(["b"]), files)]).toEqual(["a", "b"]);
  });

  it("unticks everything from all", () => {
    expect(toggleAll(new Set(["a", "b"]), files).size).toBe(0);
  });
});
