import { describe, expect, it } from "vitest";
import { commitBlock, revertBlock } from "../commitActions";
import type { CheckoutChanges } from "../store";

const checkout = (over: Partial<CheckoutChanges> = {}): CheckoutChanges => ({
  path: "/repo",
  worktree_of: null,
  branch: "main",
  upstream: null,
  upstream_gone: false,
  ahead: 0,
  behind: 0,
  born: true,
  operation: null,
  operation_step: null,
  conflicts: 0,
  remotes: [],
  web: null,
  origin_url: null,
  unmerged: null,
  files: [],
  total_files: 0,
  added: 0,
  removed: 0,
  commits: [],
  stashes: [],
  ...over,
});

describe("commitBlock", () => {
  it("lets a clean tree with nothing under way move", () => {
    expect(commitBlock(checkout())).toBeNull();
    expect(commitBlock(checkout({ branch: null }))).toBeNull();
  });

  it("refuses uncommitted changes, counting all of them", () => {
    expect(commitBlock(checkout({ total_files: 1 }))).toBe("1 uncommitted change");
    expect(commitBlock(checkout({ total_files: 60 }))).toBe("60 uncommitted changes");
  });

  it("refuses each operation under way first", () => {
    for (const operation of ["rebase", "merge", "cherry-pick", "revert"] as const) {
      expect(commitBlock(checkout({ operation, total_files: 2 }))).toBe(`${operation} under way`);
    }
  });
});

describe("revertBlock", () => {
  it("also needs a branch to land on", () => {
    expect(revertBlock(checkout())).toBeNull();
    expect(revertBlock(checkout({ branch: null }))).toBe("HEAD is detached");
    expect(revertBlock(checkout({ branch: null, total_files: 1 }))).toBe("1 uncommitted change");
  });
});
