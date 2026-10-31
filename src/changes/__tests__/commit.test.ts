import { describe, expect, it } from "vitest";
import { RecentReads, commitBeside, splitMessage } from "../commit";
import type { RecentCommit } from "../store";

describe("splitMessage", () => {
  it("takes the first line as the title and the rest as the body", () => {
    expect(splitMessage("fix: the title\n\nWhy it changed.\n\nMore.\n")).toEqual({
      title: "fix: the title",
      body: "Why it changed.\n\nMore.",
    });
  });

  it("leaves a body empty when there is none", () => {
    expect(splitMessage("docs: a small change")).toEqual({ title: "docs: a small change", body: "" });
  });

  it("moves an old subject's details into the body", () => {
    expect(splitMessage("feat: short - the long story - with a dash")).toEqual({
      title: "feat: short",
      body: "the long story - with a dash",
    });
  });

  it("puts an old subject's details before an existing body", () => {
    expect(splitMessage("fix(ui)!: short - details\n\nbody")).toEqual({ title: "fix(ui)!: short", body: "details\n\nbody" });
  });

  it("keeps the dash of a subject without a type", () => {
    expect(splitMessage("Merge main - again")).toEqual({ title: "Merge main - again", body: "" });
    expect(splitMessage("note: a - b")).toEqual({ title: "note: a - b", body: "" });
  });
});

describe("commitBeside", () => {
  const commits = ["a", "b", "c"].map((sha) => ({ sha }) as RecentCommit);

  it("steps along the list", () => {
    expect(commitBeside(commits, "b", 1)?.sha).toBe("c");
    expect(commitBeside(commits, "b", -1)?.sha).toBe("a");
  });

  it("stops at both ends", () => {
    expect(commitBeside(commits, "a", -1)).toBeNull();
    expect(commitBeside(commits, "c", 1)).toBeNull();
  });

  it("goes nowhere from a commit that left the list", () => {
    expect(commitBeside(commits, "gone", -1)).toBeNull();
  });
});

describe("RecentReads", () => {
  it("drops the one read longest ago", () => {
    const reads = new RecentReads<number>(2);
    reads.set("a", 1);
    reads.set("b", 2);
    reads.get("a");
    reads.set("c", 3);
    expect(reads.get("a")).toBe(1);
    expect(reads.get("b")).toBeUndefined();
    expect(reads.get("c")).toBe(3);
  });
});
