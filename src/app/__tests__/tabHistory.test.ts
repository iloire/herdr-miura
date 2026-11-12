import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, stepTarget, type TabHistory, visit } from "../tabHistory";

const visits = (...ids: string[]) => ids.reduce<TabHistory>((history, id) => visit(history, id, null), EMPTY_HISTORY);
const open = (...ids: string[]) => new Set(ids);

describe("tab history", () => {
  it("goes back to the tab left, and forward again", () => {
    const history = visits("a", "b", "c");
    expect(stepTarget(history, "back", open("a", "b", "c"))).toBe("b");
    const back = visit(history, "b", { direction: "back", target: "b" });
    expect(back).toEqual({ back: ["a"], forward: ["c"], current: "b" });
    expect(stepTarget(back, "forward", open("a", "b", "c"))).toBe("c");
    expect(visit(back, "c", { direction: "forward", target: "c" })).toEqual(history);
  });

  it("has nowhere to go at either end", () => {
    expect(stepTarget(EMPTY_HISTORY, "back", open())).toBeNull();
    expect(stepTarget(visits("a"), "back", open("a"))).toBeNull();
    expect(stepTarget(visits("a", "b"), "forward", open("a", "b"))).toBeNull();
  });

  it("skips closed tabs", () => {
    const history = visits("a", "b", "c");
    expect(stepTarget(history, "back", open("a", "c"))).toBe("a");
    expect(visit(history, "a", { direction: "back", target: "a" })).toEqual({ back: [], forward: ["c"], current: "a" });
  });

  it("drops what lay ahead on a new visit", () => {
    const back = visit(visits("a", "b", "c"), "b", { direction: "back", target: "b" });
    expect(visit(back, "d", null)).toEqual({ back: ["a", "b"], forward: [], current: "d" });
  });

  it("treats a focus the step didn't ask for as a visit", () => {
    const history = visits("a", "b");
    expect(visit(history, "c", { direction: "back", target: "a" })).toEqual({ back: ["a", "b"], forward: [], current: "c" });
  });

  it("ignores a repeat of the current tab and no focus at all", () => {
    const history = visits("a", "b");
    expect(visit(history, "b", null)).toBe(history);
    expect(visit(history, null, null)).toBe(history);
  });

  it("keeps a bounded list", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `t${i}`);
    expect(visits(...ids).back).toHaveLength(50);
  });
});
