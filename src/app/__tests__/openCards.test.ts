import { describe, expect, it } from "vitest";
import { AUTO_CLOSE_HOLD_MS, type AutoCard, type AutoCards, autoCardShown, cardOpen, chooseAutoCard, hasChevron, loadOpenCards, nextAutoClose, saveOpenCards, stepAutoCard, stepAutoCards, toggleCard } from "../openCards";

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

  it("follows the automatic state in auto", () => {
    expect(cardOpen("auto", true, true)).toBe(true);
    expect(cardOpen("auto", true, false)).toBe(false);
  });

  it("gives a chevron only to the modes that listen to one", () => {
    expect(["manual", "auto", "always", "never"].filter((mode) => hasChevron(mode as "manual"))).toEqual(["manual", "auto"]);
  });

  it("never opens a card with nothing to show", () => {
    for (const mode of ["manual", "auto", "always", "never"] as const) expect(cardOpen(mode, false, true)).toBe(false);
  });
});

describe("auto cards", () => {
  const HOLD = AUTO_CLOSE_HOLD_MS;
  /// Steps through `[time, wants]` pairs from `card`.
  const run = (card: AutoCard | undefined, ...steps: [number, boolean][]) =>
    steps.reduce<AutoCard | undefined>((current, [now, wants]) => stepAutoCard(current, wants, now), card) as AutoCard;
  const open = run(undefined, [0, true]);
  const closed = run(undefined, [0, false]);

  it("starts as its agents want it, with nothing to wait for", () => {
    expect(autoCardShown(open)).toBe(true);
    expect(autoCardShown(closed)).toBe(false);
    expect(open.closingSince).toBeNull();
    expect(closed.closingSince).toBeNull();
  });

  it("opens at once", () => {
    expect(autoCardShown(stepAutoCard(closed, true, 1))).toBe(true);
  });

  it("closes only once that has held", () => {
    expect(autoCardShown(run(open, [1000, false]))).toBe(true);
    expect(autoCardShown(run(open, [1000, false], [1000 + HOLD - 1, false]))).toBe(true);
    expect(autoCardShown(run(open, [1000, false], [1000 + HOLD, false]))).toBe(false);
  });

  it("does not flicker when an agent stops and starts again quickly", () => {
    const flipping = run(open, [1000, false], [1100, true], [1200, false], [1300, true], [1400, false], [1000 + HOLD, false]);
    expect(autoCardShown(flipping)).toBe(true);
    expect(flipping.closingSince).toBe(1400);
  });

  it("gives back the same object when nothing changed", () => {
    expect(stepAutoCard(open, true, 5)).toBe(open);
    expect(stepAutoCard(closed, false, 5)).toBe(closed);
    const closing = stepAutoCard(open, false, 5);
    expect(stepAutoCard(closing, false, 6)).toBe(closing);
  });

  it("lets the chevron close a card its agents want open", () => {
    const chosen = chooseAutoCard(open);
    expect(autoCardShown(chosen)).toBe(false);
    expect(autoCardShown(stepAutoCard(chosen, true, 1))).toBe(false);
  });

  it("lets the chevron open a card its agents do not need", () => {
    const chosen = chooseAutoCard(closed);
    expect(autoCardShown(chosen)).toBe(true);
    expect(autoCardShown(stepAutoCard(chosen, false, 1))).toBe(true);
  });

  it("ends the override when the automatic state changes", () => {
    const opened = stepAutoCard(chooseAutoCard(closed), true, 1);
    expect(opened.chevron).toBeNull();
    const closes = run(chooseAutoCard(open), [1, false], [1 + HOLD, false]);
    expect(closes.chevron).toBeNull();
    // The rule rules again: this card now opens with its next agent.
    expect(autoCardShown(stepAutoCard(closes, true, 1 + HOLD))).toBe(true);
  });

  it("keeps the override through a flip too quick to change the automatic state", () => {
    const chosen = run(chooseAutoCard(open), [1, false], [100, true]);
    expect(autoCardShown(chosen)).toBe(false);
  });

  it("drops the override when the chevron goes back to the automatic state", () => {
    expect(chooseAutoCard(chooseAutoCard(open)).chevron).toBeNull();
  });

  it("steps every workspace, dropping those gone, and keeps the map when nothing moved", () => {
    const cards: AutoCards = new Map([["w1", open], ["gone", closed]]);
    const next = stepAutoCards(cards, new Map([["w1", true], ["w2", false]]), 1);
    expect([...next.keys()]).toEqual(["w1", "w2"]);
    expect(next.get("w1")).toBe(open);
    expect(stepAutoCards(next, new Map([["w1", true], ["w2", false]]), 2)).toBe(next);
    expect(stepAutoCards(next, new Map(), 3).size).toBe(0);
  });

  it("says when the earliest held close falls due", () => {
    expect(nextAutoClose(new Map([["w1", open]]))).toBeNull();
    const early = stepAutoCard(open, false, 10);
    const late = stepAutoCard(open, false, 20);
    expect(nextAutoClose(new Map([["w2", late], ["w1", early]]))).toBe(10 + HOLD);
  });
});
