import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, stepTarget, stepTargets, type TabHistory, visit } from "../tabHistory";

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

describe("tab history jumps", () => {
  it("lists each open tab once, nearest first, without the current one", () => {
    const history = visits("a", "b", "a", "c", "d", "b", "e");
    expect(stepTargets(history, "back", open("a", "b", "c", "d", "e"))).toEqual(["b", "d", "c", "a"]);
    expect(stepTargets(history, "back", open("a", "b", "e"))).toEqual(["b", "a"]);
    expect(stepTargets(history, "back", open("a", "b", "c", "d", "e"), 2)).toEqual(["b", "d"]);
    expect(stepTargets(history, "forward", open("a", "b", "c", "d", "e"))).toEqual([]);
  });

  it("moves the tabs jumped over to the other side, as single steps would", () => {
    const all = open("a", "b", "c", "d", "e");
    const history = visits("a", "b", "c", "d", "e");
    const jumped = visit(history, "b", { direction: "back", target: "b", open: all });
    let stepped = history;
    for (const id of ["d", "c", "b"]) stepped = visit(stepped, id, { direction: "back", target: id });
    expect(jumped).toEqual({ back: ["a"], forward: ["e", "d", "c"], current: "b" });
    expect(stepped.back).toEqual(jumped.back);
    expect(stepTarget(jumped, "forward", all)).toBe("c");

    const ahead = visit(jumped, "e", { direction: "forward", target: "e", open: all });
    expect(ahead).toEqual({ back: ["a", "b", "c", "d"], forward: [], current: "e" });
  });

  it("drops closed tabs jumped over", () => {
    const history = visits("a", "b", "c", "d", "e");
    expect(visit(history, "b", { direction: "back", target: "b", open: open("a", "b", "d", "e") })).toEqual({
      back: ["a"],
      forward: ["e", "d"],
      current: "b",
    });
  });
});
