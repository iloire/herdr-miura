import { describe, expect, it } from "vitest";
import { changeDrafts, draftKey, loadDrafts, type NewDraft, setEdit, setFresh } from "../promptDrafts";

function memory(start: string | null = null) {
  let held = start;
  return {
    getItem: () => held,
    setItem: (_key: string, value: string) => {
      held = value;
    },
  };
}

const edit = { text: "Mine", base: "File" };
const form: NewDraft = { name: "", scope: "project", description: "", text: "" };

describe("prompt drafts", () => {
  it("come back after the palette is gone", () => {
    const storage = memory();
    changeDrafts((drafts) => setFresh(setEdit(drafts, "/p/a.md", edit), { ...form, text: "New" }), storage);
    expect(loadDrafts(storage)).toEqual({ edits: { "/p/a.md": edit }, fresh: { ...form, text: "New" } });
  });

  it("build on what storage holds, so another window's stay", () => {
    const storage = memory();
    const mine = changeDrafts((drafts) => setEdit(drafts, "/p/a.md", edit), storage);
    changeDrafts((drafts) => setEdit(drafts, "/p/b.md", edit), storage);
    changeDrafts((drafts) => setEdit(drafts, "/p/a.md", { ...edit, text: "More" }), storage);
    expect(Object.keys(mine.edits)).toEqual(["/p/a.md"]);
    expect(Object.keys(loadDrafts(storage).edits).sort()).toEqual(["/p/a.md", "/p/b.md"]);
  });

  it("drop only the edit that was saved or sent", () => {
    const start = setEdit(setEdit({ edits: {}, fresh: null }, "a", edit), "b", edit);
    expect(Object.keys(setEdit(start, "a", null).edits)).toEqual(["b"]);
  });

  it("keep any field of the form, but an empty form is none", () => {
    const empty = { edits: {}, fresh: null };
    expect(setFresh(empty, form).fresh).toBeNull();
    expect(setFresh(empty, { ...form, text: " \n" }).fresh).toBeNull();
    for (const typed of [{ name: "a" }, { description: "b" }, { text: "c" }]) {
      expect(setFresh(empty, { ...form, ...typed }).fresh).toEqual({ ...form, ...typed });
    }
  });

  it("are told apart by file, as the same name is in every project", () => {
    const one = draftKey({ dir: "/one/.claude/commands", path: "land.md" });
    expect(one).not.toBe(draftKey({ dir: "/two/.claude/commands", path: "land.md" }));
  });

  it("survive storage that is corrupt or refuses them", () => {
    expect(loadDrafts(memory("{oops"))).toEqual({ edits: {}, fresh: null });
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(changeDrafts((drafts) => setEdit(drafts, "a", edit), refusing).edits).toEqual({ a: edit });
  });
});
