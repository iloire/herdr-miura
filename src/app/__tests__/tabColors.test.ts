import { describe, expect, it } from "vitest";
import type { HueSlot } from "../hue";
import { pinKey } from "../pins";
import { loadTabColors, saveTabColors, withoutClosedTabs } from "../tabColors";

const memory = () => {
  const store = new Map<string, string>();
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
};

describe("loadTabColors and saveTabColors", () => {
  it("round-trips the running daemon's colors, by slot name", () => {
    const storage = memory();
    saveTabColors(new Map<string, HueSlot>([[pinKey("boot", "t1"), "yellow"]]), "boot", storage);
    expect(storage.getItem("tab-colors")).toBe('{"boot/t1":"yellow"}');
    expect([...loadTabColors(storage)]).toEqual([["boot/t1", "yellow"]]);
  });

  it("drops other boots' entries on save", () => {
    const storage = memory();
    const colors = new Map<string, HueSlot>([
      [pinKey("boot1", "t1"), "red"],
      [pinKey("boot2", "t1"), "blue"],
    ]);
    saveTabColors(colors, "boot2", storage);
    expect([...loadTabColors(storage)]).toEqual([["boot2/t1", "blue"]]);
  });

  it("reads nothing from a bad value or storage that throws", () => {
    for (const bad of ["{not json", "null", "3", '"red"', '["red"]']) {
      expect(loadTabColors({ getItem: () => bad }).size).toBe(0);
    }
    expect(
      loadTabColors({
        getItem: () => {
          throw new Error("blocked");
        },
      }).size,
    ).toBe(0);
  });

  it("skips an entry that is not one of the slots, keeping the rest", () => {
    expect([...loadTabColors({ getItem: () => '{"b/a":"mauve","b/b":7,"b/c":"cyan"}' })]).toEqual([["b/c", "cyan"]]);
  });

  it("does without storage that refuses a write", () => {
    const refusing = {
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => saveTabColors(new Map(), "boot", refusing)).not.toThrow();
  });
});

describe("withoutClosedTabs", () => {
  const colors = new Map<string, HueSlot>([
    ["boot/t1", "red"],
    ["boot/t2", "blue"],
    ["old/t3", "green"],
  ]);

  it("drops a closed tab of this boot and leaves other boots' to the next save", () => {
    expect([...withoutClosedTabs(colors, "boot", ["t2", "t9"])]).toEqual([
      ["boot/t2", "blue"],
      ["old/t3", "green"],
    ]);
  });

  it("hands back the same map when no tab closed", () => {
    expect(withoutClosedTabs(colors, "boot", ["t1", "t2"])).toBe(colors);
  });
});
