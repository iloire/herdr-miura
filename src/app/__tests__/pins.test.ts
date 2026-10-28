import { describe, expect, it } from "vitest";
import type { Tab } from "../../protocol";
import { loadPins, pinIndex, pinKey, pinnedFirst, savePins } from "../pins";

const tab = (tab_id: string, workspace_id = "w"): Tab => ({
  tab_id,
  workspace_id,
  number: 1,
  label: tab_id,
  custom_label: false,
  zoomed: false,
  focused: false,
  agent_status: "idle",
});

describe("pinnedFirst", () => {
  it("puts pinned tabs first and keeps the daemon's order within each group", () => {
    const pinned = new Set(["c", "a"]);
    const order = pinnedFirst([tab("a"), tab("b"), tab("c"), tab("d")], (t) => pinned.has(t.tab_id));
    expect(order.map((t) => t.tab_id)).toEqual(["a", "c", "b", "d"]);
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
