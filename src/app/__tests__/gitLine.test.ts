import { describe, expect, it } from "vitest";
import type { ChangesState, CheckoutChanges } from "../../changes/store";
import { hasGitLine, shownBranch, tabGit } from "../gitLine";

const checkout = (over: Partial<CheckoutChanges> = {}): CheckoutChanges => ({
  path: "/repo",
  branch: "main",
  upstream: "origin/main",
  upstream_gone: false,
  ahead: 0,
  behind: 0,
  born: true,
  operation: null,
  remotes: ["origin"],
  unmerged: null,
  files: [],
  total_files: 0,
  added: 0,
  removed: 0,
  commits: [],
  ...over,
});

const ready = (over: Partial<CheckoutChanges> = {}, directory = "/repo"): ChangesState => ({
  phase: "ready",
  directory,
  checkout: checkout(over),
  at: 0,
});

describe("shownBranch", () => {
  it("hides main and master", () => {
    expect(shownBranch("main")).toBeNull();
    expect(shownBranch("master")).toBeNull();
  });

  it("shows any other branch, even one that only starts like them", () => {
    expect(shownBranch("feat/thing")).toBe("feat/thing");
    expect(shownBranch("main-backup")).toBe("main-backup");
  });

  it("has nothing to show outside Git", () => {
    expect(shownBranch(null)).toBeNull();
  });
});

describe("hasGitLine", () => {
  it("keeps the line on main while any count is above zero", () => {
    expect(hasGitLine("main", [1, 0, 0, 0])).toBe(true);
    expect(hasGitLine("master", [0, 2, 0, 0])).toBe(true);
    expect(hasGitLine("main", [0, 0, 3, 0])).toBe(true);
    expect(hasGitLine("main", [0, 0, 0, 1])).toBe(true);
  });

  it("drops the line on main when every count is zero", () => {
    expect(hasGitLine("main", [0, 0, 0, 0])).toBe(false);
    expect(hasGitLine("master", [0, 0, 0, 0])).toBe(false);
  });

  it("keeps the line for another branch with nothing pending", () => {
    expect(hasGitLine("feat/thing", [0, 0, 0, 0])).toBe(true);
  });

  it("drops the line outside Git, or on an empty branch name", () => {
    expect(hasGitLine(null, [0, 0, 0, 0])).toBe(false);
    expect(hasGitLine("", [0, 0, 0, 0])).toBe(false);
  });
});

describe("tabGit", () => {
  it("says nothing on a clean, pushed main", () => {
    expect(tabGit(ready(), "/repo")).toBeNull();
    expect(tabGit(ready({ branch: "master" }), "/repo")).toBeNull();
  });

  it("keeps unpushed work on main, without naming main", () => {
    expect(tabGit(ready({ ahead: 2 }), "/repo")).toEqual({
      branch: null,
      changed: 0,
      ahead: 2,
      behind: 0,
      unmerged: null,
    });
  });

  it("counts every changed file, not only the listed ones", () => {
    const files = [{ path: "a", mark: "M", additions: 1, deletions: 0 }];
    expect(tabGit(ready({ files, total_files: 80 }), "/repo")?.changed).toBe(80);
  });

  it("names a feature branch with nothing pending", () => {
    expect(tabGit(ready({ branch: "feat/thing", unmerged: ["origin/main", 0] }), "/repo")).toEqual({
      branch: "feat/thing",
      changed: 0,
      ahead: 0,
      behind: 0,
      unmerged: null,
    });
  });

  it("gives unmerged commits with their base", () => {
    expect(tabGit(ready({ branch: "feat/thing", unmerged: ["origin/main", 3] }), "/repo")?.unmerged).toEqual({
      count: 3,
      base: "origin/main",
    });
  });

  it("speaks on main for unmerged commits alone", () => {
    expect(tabGit(ready({ upstream: null, unmerged: ["origin/main", 1] }), "/repo")?.unmerged?.count).toBe(1);
  });

  it("never shows another directory's checkout", () => {
    expect(tabGit(ready({ branch: "feat/other" }, "/other"), "/repo")).toBeNull();
    expect(tabGit(ready({ branch: "feat/other" }), null)).toBeNull();
  });

  it("says nothing until a read for this directory is ready", () => {
    expect(tabGit({ phase: "idle" }, "/repo")).toBeNull();
    expect(tabGit({ phase: "loading", directory: "/repo" }, "/repo")).toBeNull();
    expect(tabGit({ phase: "failed", directory: "/repo", error: "no" }, "/repo")).toBeNull();
  });

  it("says nothing outside Git", () => {
    expect(tabGit({ phase: "ready", directory: "/tmp", checkout: null, at: 0 }, "/tmp")).toBeNull();
  });

  it("says nothing on a clean detached HEAD", () => {
    expect(tabGit(ready({ branch: null, upstream: null }), "/repo")).toBeNull();
  });
});
