import { describe, expect, it } from "vitest";
import { cardOpen, loadOpenCards, saveOpenCards, toggleCard } from "../openCards";

function memory(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("open cards", () => {
  it("remembers which cards are open", () => {
    const storage = memory();
    saveOpenCards(new Set(["w1", "w2"]), storage);
    expect(loadOpenCards(storage)).toEqual(new Set(["w1", "w2"]));
  });

  it("starts with every card collapsed", () => {
    expect(loadOpenCards(memory())).toEqual(new Set());
  });

  it("treats a stored value it cannot read as nothing open", () => {
    expect(loadOpenCards(memory("not json"))).toEqual(new Set());
    expect(loadOpenCards(memory('{"w1":true}'))).toEqual(new Set());
    expect(loadOpenCards(memory('["w1",2]'))).toEqual(new Set(["w1"]));
  });

  it("flips a card and leaves the others", () => {
    const live = ["w1", "w2"];
    expect(toggleCard(new Set(["w1"]), "w2", live)).toEqual(new Set(["w1", "w2"]));
    expect(toggleCard(new Set(["w1", "w2"]), "w1", live)).toEqual(new Set(["w2"]));
  });

  it("forgets workspaces that are gone", () => {
    expect(toggleCard(new Set(["gone", "w1"]), "w2", ["w1", "w2"])).toEqual(new Set(["w1", "w2"]));
  });

  it("follows the chevron in manual, and overrides it otherwise", () => {
    expect(cardOpen("manual", true, true)).toBe(true);
    expect(cardOpen("manual", true, false)).toBe(false);
    expect(cardOpen("always", true, false)).toBe(true);
    expect(cardOpen("never", true, true)).toBe(false);
  });

  it("never opens a card with nothing to show", () => {
    for (const mode of ["manual", "always", "never"] as const) expect(cardOpen(mode, false, true)).toBe(false);
  });
});
