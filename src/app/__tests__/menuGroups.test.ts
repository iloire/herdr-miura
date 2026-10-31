import { describe, expect, it } from "vitest";
import { menuGroups } from "../menuGroups";

describe("menuGroups", () => {
  it("treats a flat list as one group, so it gets no dividers", () => {
    expect(menuGroups(["a", "b"])).toEqual([["a", "b"]]);
  });

  it("keeps groups in order", () => {
    expect(menuGroups<string>([["a", "b"], ["c"], ["d"]])).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("drops empty groups wherever they are, leaving no stray divider", () => {
    expect(menuGroups<string>([["a"], [], ["b"]])).toEqual([["a"], ["b"]]);
    expect(menuGroups<string>([[], ["a"]])).toEqual([["a"]]);
    expect(menuGroups<string>([["a"], [], []])).toEqual([["a"]]);
  });

  it("has nothing to draw for an empty menu", () => {
    expect(menuGroups([])).toEqual([]);
    expect(menuGroups<string>([[], []])).toEqual([]);
  });
});
