import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, loadLayout, saveLayout } from "../layout";

function memory(initial?: string) {
  const store = new Map<string, string>(initial === undefined ? [] : [["layout", initial]]);
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
}

describe("loadLayout and saveLayout", () => {
  it("starts from the default when nothing is stored", () => {
    expect(loadLayout(memory())).toEqual(DEFAULT_LAYOUT);
  });

  it("merges each save over what is stored", () => {
    const storage = memory();
    saveLayout({ sidebar: false, drawer: "files" }, storage);
    saveLayout({ treeFile: { root: "/repo", path: "src/a.ts" } }, storage);
    expect(loadLayout(storage)).toEqual({
      sidebar: false,
      drawer: "files",
      changesFile: null,
      treeFile: { root: "/repo", path: "src/a.ts" },
    });
  });

  it("drops what it cannot use and keeps the rest", () => {
    const storage = memory(JSON.stringify({ sidebar: "no", drawer: "diff", changesFile: { root: 3 }, treeFile: { root: "/r", path: "x" } }));
    expect(loadLayout(storage)).toEqual({ ...DEFAULT_LAYOUT, treeFile: { root: "/r", path: "x" } });
  });

  it("falls back to the default on broken JSON or storage that throws", () => {
    expect(loadLayout(memory("{"))).toEqual(DEFAULT_LAYOUT);
    expect(loadLayout(memory("null"))).toEqual(DEFAULT_LAYOUT);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadLayout(throwing)).toEqual(DEFAULT_LAYOUT);
    expect(() => saveLayout({ sidebar: false }, throwing)).not.toThrow();
  });
});
