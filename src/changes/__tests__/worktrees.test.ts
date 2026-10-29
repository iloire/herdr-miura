import { describe, expect, it } from "vitest";
import { isPending, type Worktree, worktreeTitle } from "../worktrees";

const worktree = (overrides: Partial<Worktree>): Worktree => ({
  path: "/r/.claude/worktrees/venice",
  branch: "venice",
  subject: null,
  time: null,
  base: "origin/main",
  unmerged: 0,
  changed: 0,
  ...overrides,
});

describe("worktrees", () => {
  it("counts unmerged commits or uncommitted files as pending", () => {
    expect(isPending(worktree({}))).toBe(false);
    expect(isPending(worktree({ unmerged: 2 }))).toBe(true);
    expect(isPending(worktree({ changed: 1 }))).toBe(true);
    expect(isPending(worktree({ unmerged: null, changed: null }))).toBe(false);
  });

  it("titles the mark with what is pending in each", () => {
    const title = worktreeTitle([
      worktree({ unmerged: 3, changed: 2 }),
      worktree({ branch: "hong-kong" }),
      worktree({ branch: null, path: "/r/probe", unmerged: null }),
    ]);
    expect(title.split("\n")).toEqual([
      "3 worktrees, 1 not merged",
      "venice: 3 unmerged, 2 changed",
      "hong-kong: merged, clean",
      "probe (detached): clean",
    ]);
  });

  it("says when everything is merged", () => {
    expect(worktreeTitle([worktree({})]).split("\n")[0]).toBe("1 worktree, all merged");
  });
});
