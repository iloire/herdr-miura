import { describe, expect, it } from "vitest";
import type { Tab } from "../../protocol";
import { loadPins, pinIndex, pinKey, pinnedByWorkspace, savePins, stripOrder } from "../pins";

const tab = (tab_id: string, workspace_id = "w", agent_status: Tab["agent_status"] = "idle"): Tab => ({
  tab_id,
  workspace_id,
  number: 1,
  label: tab_id,
  custom_label: false,
  zoomed: false,
  focused: false,
  agent_status,
});

describe("stripOrder", () => {
  it("puts pinned tabs first and keeps the daemon's order within each group", () => {
    const pinned = new Set(["c", "a"]);
    const order = stripOrder([tab("a"), tab("b"), tab("c"), tab("d")], (t) => pinned.has(t.tab_id), () => false);
    expect(order.map((t) => t.tab_id)).toEqual(["a", "c", "b", "d"]);
  });

  it("puts the working tabs right after the pinned ones", () => {
    const working = new Set(["c", "d", "e"]);
    const order = stripOrder(
      [tab("a"), tab("b"), tab("c"), tab("d"), tab("e")],
      (t) => t.tab_id === "e" || t.tab_id === "a",
      (t) => working.has(t.tab_id),
    );
    expect(order.map((t) => t.tab_id)).toEqual(["a", "e", "c", "d", "b"]);
  });

  it("orders by the working set it is given, not by the tab's status now", () => {
    const tabs = [tab("a", "w", "working"), tab("b", "w", "idle")];
    const held = new Set(["b"]);
    const order = stripOrder(tabs, () => false, (t) => held.has(t.tab_id));
    expect(order.map((t) => t.tab_id)).toEqual(["b", "a"]);
  });
});

describe("pinnedByWorkspace", () => {
  it("groups pinned tabs under their workspace and leaves out workspaces with none", () => {
    const pinned = new Set(["a", "c", "x"]);
    const byWorkspace = pinnedByWorkspace([tab("a"), tab("b"), tab("x", "other"), tab("c"), tab("y", "none")], (t) =>
      pinned.has(t.tab_id),
    );
    expect([...byWorkspace].map(([w, tabs]) => [w, tabs.map((t) => t.tab_id)])).toEqual([
      ["w", ["a", "c"]],
      ["other", ["x"]],
    ]);
  });
});

describe("pinIndex", () => {
  it("lands a tab right after the other pinned tabs of its own workspace", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("x", "other")];
    const pinned = new Set(["a", "x"]);
    expect(pinIndex(tabs, tabs[2], (t) => pinned.has(t.tab_id))).toBe(1);
    // Unpinning the only pinned tab sends it to the front of the rest.
    expect(pinIndex(tabs, tabs[0], (t) => t.tab_id === "a")).toBe(0);
  });
});

describe("loadPins and savePins", () => {
  it("round-trips the running daemon's pins and forgets an old boot's", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    savePins(new Set([pinKey("boot2", "t1"), pinKey("boot1", "t1")]), "boot2", storage);
    expect([...loadPins(storage)]).toEqual(["boot2/t1"]);
  });

  it("reads nothing from garbage or storage that throws", () => {
    expect(loadPins({ getItem: () => "{not json" }).size).toBe(0);
    expect(loadPins({ getItem: () => '{"a":1}' }).size).toBe(0);
    expect(
      loadPins({
        getItem: () => {
          throw new Error("blocked");
        },
      }).size,
    ).toBe(0);
  });
});
