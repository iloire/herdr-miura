import { describe, expect, it } from "vitest";
import { AGENTS_MIN_HEIGHT, clampAgentsHeight, loadAgentsPanel, saveAgentsPanel, WORKSPACES_MIN_HEIGHT } from "../agentsPanel";

function memory(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("agents panel", () => {
  it("remembers its height and fold", () => {
    const storage = memory();
    saveAgentsPanel({ height: 240, folded: true }, storage);
    expect(loadAgentsPanel(storage)).toEqual({ height: 240, folded: true });
  });

  it("starts open at its natural height", () => {
    expect(loadAgentsPanel(memory())).toEqual({ height: null, folded: false });
  });

  it("treats a stored value it cannot read as the default", () => {
    expect(loadAgentsPanel(memory("not json"))).toEqual({ height: null, folded: false });
    expect(loadAgentsPanel(memory('{"height":"tall","folded":1}'))).toEqual({ height: null, folded: false });
    expect(loadAgentsPanel(memory('{"height":-5}'))).toEqual({ height: null, folded: false });
  });

  it("keeps room for the workspaces and a row of agents", () => {
    expect(clampAgentsHeight(10, 800)).toBe(AGENTS_MIN_HEIGHT);
    expect(clampAgentsHeight(2000, 800)).toBe(800 - WORKSPACES_MIN_HEIGHT);
    expect(clampAgentsHeight(300.4, 800)).toBe(300);
    expect(clampAgentsHeight(300, 100)).toBe(AGENTS_MIN_HEIGHT);
  });
});
