import { describe, expect, it } from "vitest";
import { hasGitLine, shownBranch } from "../gitLine";

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
