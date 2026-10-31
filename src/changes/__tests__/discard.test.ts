import { describe, expect, it } from "vitest";
import { discardSummary, fileAfter, promisesCopy, type DiscardPlan } from "../discard";
import type { ChangedFile } from "../store";

const plan = (fields: Partial<DiscardPlan>): DiscardPlan => ({
  effect: "revert",
  old_path: null,
  additions: 1,
  deletions: 1,
  drops_staged: false,
  keeps_copy: true,
  fingerprint: "f",
  ...fields,
});

const file = (path: string): ChangedFile => ({ path, mark: "M", additions: 1, deletions: 0 });

describe("discardSummary", () => {
  it("names a rename's old path", () => {
    expect(discardSummary(plan({ effect: "rename_back", old_path: "old.ts" }))).toContain("old.ts");
  });

  it("says what happens to each kind of file", () => {
    expect(discardSummary(plan({ effect: "remove" }))).toContain("removed");
    expect(discardSummary(plan({ effect: "bring_back" }))).toContain("comes back");
    expect(discardSummary(plan({ effect: "trash" }))).toContain("Trash");
  });
});

describe("promisesCopy", () => {
  it("promises a copy only of a file that stays until the copy is safe", () => {
    expect(promisesCopy(plan({}))).toBe(true);
    expect(promisesCopy(plan({ effect: "trash" }))).toBe(false);
    expect(promisesCopy(plan({ effect: "bring_back", keeps_copy: false }))).toBe(false);
  });
});

describe("fileAfter", () => {
  const files = [file("a"), file("b"), file("c")];

  it("moves to the next file", () => {
    expect(fileAfter(files, "a")?.path).toBe("b");
  });

  it("has nothing after the last, or for a file not listed", () => {
    expect(fileAfter(files, "c")).toBeNull();
    expect(fileAfter(files, "z")).toBeNull();
  });
});
