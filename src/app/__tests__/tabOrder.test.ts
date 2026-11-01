import { describe, expect, it } from "vitest";
import type { Agent, Tab } from "../../protocol";
import { loadTabSort, saveTabSort, stripOrder, tabRanks } from "../tabOrder";

const tab = (tab_id: string, agent_status: Tab["agent_status"] = "idle"): Tab => ({
  tab_id,
  workspace_id: "w",
  number: 1,
  label: tab_id,
  custom_label: false,
  zoomed: false,
  focused: false,
  agent_status,
});

const ids = (tabs: Tab[]) => tabs.map((t) => t.tab_id);

describe("stripOrder", () => {
  it("puts pinned tabs first and keeps the daemon's order within each group", () => {
    const pinned = new Set(["c", "a"]);
    const order = stripOrder([tab("a"), tab("b"), tab("c"), tab("d")], (t) => pinned.has(t.tab_id), new Map());
    expect(ids(order)).toEqual(["a", "c", "b", "d"]);
  });

  it("puts the ranked tabs right after the pinned ones, highest first", () => {
    const ranks = new Map([["c", 1], ["d", 2], ["e", 1]]);
    const order = stripOrder([tab("a"), tab("b"), tab("c"), tab("d"), tab("e")], (t) => t.tab_id === "e" || t.tab_id === "a", ranks);
    expect(ids(order)).toEqual(["a", "e", "d", "c", "b"]);
  });

  it("orders by the ranks it is given, not by the tab's status now", () => {
    const order = stripOrder([tab("a", "working"), tab("b", "idle")], () => false, new Map([["b", 1]]));
    expect(ids(order)).toEqual(["b", "a"]);
  });
});

describe("tabRanks", () => {
  const tabs = [tab("a"), tab("b", "working"), tab("c", "blocked"), tab("d", "done"), tab("e", "blocked"), tab("f", "unknown")];
  const sorted = (ranks: Map<string, number>, list = tabs) => ids(stripOrder(list, () => false, ranks));

  it("moves only working tabs by default", () => {
    expect(sorted(tabRanks(tabs, "working", []))).toEqual(["b", "a", "c", "d", "e", "f"]);
  });

  it("puts what needs you first, keeping the daemon's order within a status", () => {
    expect(sorted(tabRanks(tabs, "attention", []))).toEqual(["c", "e", "d", "b", "a", "f"]);
  });

  it("ranks a finished agent that needs you with the blocked ones", () => {
    const needsYou = { tab_id: "d", agent_status: "done", tokens: [["attn_outcome", "you: run it"]] } as unknown as Agent;
    expect(sorted(tabRanks(tabs, "attention", [needsYou]))).toEqual(["c", "d", "e", "b", "a", "f"]);
  });

  it("leaves tabs at rest out, so a new idle tab moves nothing", () => {
    expect([...tabRanks([tab("a"), tab("f", "unknown")], "attention", []).keys()]).toEqual([]);
  });
});

describe("loadTabSort and saveTabSort", () => {
  it("round-trips the choice", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveTabSort("attention", storage);
    expect(loadTabSort(storage)).toBe("attention");
  });

  it("falls back to working first on anything else, or storage that throws", () => {
    expect(loadTabSort({ getItem: () => null })).toBe("working");
    expect(loadTabSort({ getItem: () => "nonsense" })).toBe("working");
    expect(
      loadTabSort({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("working");
  });
});
