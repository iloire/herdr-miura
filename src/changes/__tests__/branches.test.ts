import { describe, expect, it } from "vitest";
import { switchBlock, tracking, type Branch } from "../branches";
import type { CheckoutChanges } from "../store";

const branch = (over: Partial<Branch> = {}): Branch => ({
  name: "feat",
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  time: 0,
  current: false,
  worktree: null,
  ...over,
});

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

describe("switchBlock", () => {
  it("lets a clean checkout switch", () => {
    expect(switchBlock(checkout(), branch())).toBeNull();
  });

  it("says why a dirty tree or an operation stops it", () => {
    expect(switchBlock(checkout({ total_files: 1 }), branch())).toBe("1 uncommitted change");
    expect(switchBlock(checkout({ total_files: 3 }), branch())).toBe("3 uncommitted changes");
    expect(switchBlock(checkout({ operation: "rebase", total_files: 2 }), branch())).toBe("rebase under way");
    expect(switchBlock(checkout({ branch: null }), branch())).toBe("HEAD is detached");
  });

  it("does not offer the current branch or one checked out elsewhere", () => {
    expect(switchBlock(checkout(), branch({ current: true, worktree: "/repo" }))).toBe("current");
    expect(switchBlock(checkout(), branch({ worktree: "/repo/.claude/worktrees/feat" }))).toBe("in worktree feat");
  });
});

describe("tracking", () => {
  it("shows ahead, behind, gone or nothing", () => {
    expect(tracking(branch({ ahead: 2, behind: 1 }))).toBe("↑2 ↓1");
    expect(tracking(branch({ behind: 4 }))).toBe("↓4");
    expect(tracking(branch({ gone: true, ahead: 1 }))).toBe("gone");
    expect(tracking(branch())).toBe("");
  });
});
