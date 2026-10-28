import { describe, expect, it } from "vitest";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampWidth, loadWidth, saveWidth } from "../sidebar";

describe("clampWidth", () => {
  it("keeps a width between the bounds on a wide window", () => {
    expect(clampWidth(300, 2000)).toBe(300);
    expect(clampWidth(40, 2000)).toBe(SIDEBAR_MIN);
    expect(clampWidth(900, 2000)).toBe(SIDEBAR_MAX);
  });

  it("leaves the terminal at least half of a narrow window, never going under the minimum", () => {
    expect(clampWidth(400, 600)).toBe(300);
    expect(clampWidth(400, 200)).toBe(SIDEBAR_MIN);
  });
});

describe("loadWidth and saveWidth", () => {
  it("round-trips a width through storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveWidth(310, storage);
    expect(loadWidth(storage)).toBe(310);
  });

  it("falls back to the default when storage is empty, garbage, missing, or throws", () => {
    expect(loadWidth({ getItem: () => null })).toBe(SIDEBAR_DEFAULT);
    expect(loadWidth({ getItem: () => "wide" })).toBe(SIDEBAR_DEFAULT);
    expect(loadWidth(undefined)).toBe(SIDEBAR_DEFAULT);
    expect(
      loadWidth({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(SIDEBAR_DEFAULT);
    expect(() =>
      saveWidth(300, {
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
  });
});
