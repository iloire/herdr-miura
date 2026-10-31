import { describe, expect, it } from "vitest";
import { refLabels } from "../refLabels";
import type { CommitRef } from "../store";

const ref = (kind: CommitRef["kind"], name: string, current = false): CommitRef => ({ kind, name, current });

describe("refLabels", () => {
  it("folds a remote branch into the local branch on the same commit", () => {
    expect(refLabels([ref("branch", "main", true), ref("remote", "origin/main")])).toEqual([
      { kind: "branch", name: "main", current: true, remotes: ["origin"] },
    ]);
  });

  it("keeps a remote branch alone when its local branch is elsewhere", () => {
    expect(refLabels([ref("remote", "origin/main")])).toEqual([
      { kind: "remote", name: "origin/main", current: false, remotes: [] },
    ]);
  });

  it("matches the whole branch name, slashes included", () => {
    const labels = refLabels([ref("branch", "x"), ref("branch", "feat/x"), ref("remote", "origin/feat/x")]);
    expect(labels.find((label) => label.name === "feat/x")?.remotes).toEqual(["origin"]);
    expect(labels.find((label) => label.name === "x")?.remotes).toEqual([]);
  });

  it("puts the current branch first, then the others, remotes and tags", () => {
    const refs = [ref("tag", "v1"), ref("remote", "origin/y"), ref("branch", "a"), ref("branch", "b", true)];
    expect(refLabels(refs).map((label) => label.name)).toEqual(["b", "a", "origin/y", "v1"]);
  });
});
