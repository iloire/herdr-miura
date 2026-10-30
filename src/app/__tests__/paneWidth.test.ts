import { describe, expect, it } from "vitest";
import { DRAWER, SIDEBAR, clampDrawer, clampSidebar, loadWidth, saveWidth } from "../paneWidth";

describe("clampSidebar", () => {
  it("keeps a width between the bounds on a wide window", () => {
    expect(clampSidebar(300, 2000)).toBe(300);
    expect(clampSidebar(40, 2000)).toBe(SIDEBAR.min);
    expect(clampSidebar(900, 2000)).toBe(SIDEBAR.max);
  });

  it("leaves the terminal at least half of a narrow window, never going under the minimum", () => {
    expect(clampSidebar(400, 600)).toBe(300);
    expect(clampSidebar(400, 200)).toBe(SIDEBAR.min);
  });
});

describe("clampDrawer", () => {
  it("keeps a width between the bounds on a wide window", () => {
    expect(clampDrawer(400, 2600, 232)).toBe(400);
    expect(clampDrawer(40, 2600, 232)).toBe(DRAWER.min);
    expect(clampDrawer(900, 2600, 232)).toBe(DRAWER.max);
  });

  it("leaves the terminal at least half of what the sidebar leaves", () => {
    expect(clampDrawer(640, 1280, 232)).toBe(524);
    expect(clampDrawer(640, 1280, SIDEBAR.max)).toBe(400);
    expect(clampDrawer(640, 1280, 0)).toBe(640);
  });

  it("gives way below its minimum rather than squeeze the terminal in a narrow window", () => {
    expect(clampDrawer(320, 700, 232)).toBe(234);
    expect(clampDrawer(320, 480, 240)).toBe(120);
  });
});

describe("loadWidth and saveWidth", () => {
  it("round-trips a width through storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveWidth(SIDEBAR, 310, storage);
    expect(loadWidth(SIDEBAR, storage)).toBe(310);
  });

  it("keeps each pane's width apart, with its own default", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadWidth(DRAWER, storage)).toBe(DRAWER.default);
    saveWidth(DRAWER, 500, storage);
    expect(loadWidth(DRAWER, storage)).toBe(500);
    expect(loadWidth(SIDEBAR, storage)).toBe(SIDEBAR.default);
  });

  it("falls back to the default when storage is empty, garbage, missing, or throws", () => {
    expect(loadWidth(SIDEBAR, { getItem: () => null })).toBe(SIDEBAR.default);
    expect(loadWidth(SIDEBAR, { getItem: () => "wide" })).toBe(SIDEBAR.default);
    expect(loadWidth(SIDEBAR, undefined)).toBe(SIDEBAR.default);
    expect(
      loadWidth(SIDEBAR, {
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe(SIDEBAR.default);
    expect(() =>
      saveWidth(SIDEBAR, 300, {
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
  });
});
