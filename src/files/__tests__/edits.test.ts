import { describe, expect, it } from "vitest";
import { indentOf, lineEnding, loadFileDraft, saveFileDraft } from "../edits";

describe("lineEnding", () => {
  it("names the ending a file uses throughout", () => {
    expect(lineEnding("a\nb\n")).toBe("\n");
    expect(lineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(lineEnding("one line")).toBe("\n");
    expect(lineEnding("")).toBe("\n");
  });

  it("is null for a mix, which could not be written back as it was", () => {
    expect(lineEnding("a\r\nb\n")).toBeNull();
    expect(lineEnding("a\rb\n")).toBeNull();
  });
});

describe("indentOf", () => {
  it("reads a level from the file", () => {
    expect(indentOf("a:\n\tb\n")).toBe("\t");
    expect(indentOf("def a():\n    b\n        c\n")).toBe("    ");
    expect(indentOf("a {\n  b {\n    c\n  }\n}\n")).toBe("  ");
  });

  it("takes two spaces when the file says nothing, and ignores aligned comments", () => {
    expect(indentOf("a\nb\n")).toBe("  ");
    expect(indentOf("/**\n * a\n */\n")).toBe("  ");
  });
});

describe("file drafts", () => {
  const storage = () => {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  };

  it("keeps edits per file until told to forget them", () => {
    const store = storage();
    saveFileDraft("/repo", "a.txt", { base: "old", text: "new" }, store);
    expect(loadFileDraft("/repo", "a.txt", store)).toEqual({ base: "old", text: "new" });
    expect(loadFileDraft("/repo", "b.txt", store)).toBeNull();
    saveFileDraft("/repo", "a.txt", null, store);
    expect(loadFileDraft("/repo", "a.txt", store)).toBeNull();
  });

  it("treats a broken entry as no draft", () => {
    const store = storage();
    store.setItem("herdr.file-draft:/repo/a.txt", "{");
    expect(loadFileDraft("/repo", "a.txt", store)).toBeNull();
  });
});
