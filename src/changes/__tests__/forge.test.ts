import { describe, expect, it } from "vitest";
import {
  FORGE_GAP_MS,
  actionsUrl,
  blobUrl,
  commitUrl,
  compareUrl,
  diffLineUrl,
  lineUrl,
  comparison,
  forgeDue,
  onRemote,
  pushedBranch,
  treeUrl,
  type WebRepo,
} from "../forge";
import type { CheckoutChanges } from "../store";

const github: WebRepo = { kind: "github", host: "github.com", path: "o/r", url: "https://github.com/o/r" };
const gitlab: WebRepo = { kind: "gitlab", host: "gitlab.com", path: "g/s/p", url: "https://gitlab.com/g/s/p" };

const checkout = (over: Partial<CheckoutChanges> = {}): CheckoutChanges => ({
  worktree_of: null,
  path: "/repo",
  branch: "feat/x",
  upstream: "origin/feat/x",
  upstream_gone: false,
  ahead: 0,
  behind: 0,
  born: true,
  operation: null,
  operation_step: null,
  conflicts: 0,
  remotes: ["origin"],
  web: github,
  origin_url: null,
  unmerged: ["origin/main", 2],
  files: [],
  total_files: 0,
  added: 0,
  removed: 0,
  commits: [],
  stashes: [],
  ...over,
});

describe("links", () => {
  it("builds GitHub pages, keeping a branch's slashes", () => {
    expect(treeUrl(github, "feat/a b")).toBe("https://github.com/o/r/tree/feat/a%20b");
    expect(commitUrl(github, "abc")).toBe("https://github.com/o/r/commit/abc");
    expect(blobUrl(github, "feat/x", "src/a#b.ts")).toBe("https://github.com/o/r/blob/feat/x/src/a%23b.ts");
    expect(lineUrl(github, "abc123", "src/a b.ts", 42)).toBe("https://github.com/o/r/blob/abc123/src/a%20b.ts#L42");
    expect(compareUrl(github, "main", "feat/x")).toBe("https://github.com/o/r/compare/main...feat/x");
    expect(compareUrl(github, "main", "feat/x", true)).toBe("https://github.com/o/r/compare/main...feat/x?expand=1");
    expect(actionsUrl(github, "feat/x")).toBe("https://github.com/o/r/actions?query=branch%3Afeat%2Fx");
  });

  it("puts GitLab's pages under /-/", () => {
    expect(treeUrl(gitlab, "dev")).toBe("https://gitlab.com/g/s/p/-/tree/dev");
    expect(commitUrl(gitlab, "abc")).toBe("https://gitlab.com/g/s/p/-/commit/abc");
    expect(compareUrl(gitlab, "main", "dev", true)).toBe("https://gitlab.com/g/s/p/-/compare/main...dev");
    expect(actionsUrl(gitlab, "dev")).toBe("https://gitlab.com/g/s/p/-/pipelines?ref=dev");
  });
});

describe("diffLineUrl", () => {
  const links = { repo: github, path: "src/a.ts", old: "aaa", new: null };
  it("points each side's number at the commit it was read from", () => {
    expect(diffLineUrl(links, "old", 7)).toBe("https://github.com/o/r/blob/aaa/src/a.ts#L7");
    expect(diffLineUrl({ ...links, old: null, new: "bbb" }, "new", 3)).toBe("https://github.com/o/r/blob/bbb/src/a.ts#L3");
    expect(diffLineUrl({ ...links, repo: gitlab }, "old", 1)).toBe("https://gitlab.com/g/s/p/-/blob/aaa/src/a.ts#L1");
  });

  it("is null for a side with no commit, as the working tree's", () => {
    expect(diffLineUrl(links, "new", 7)).toBeNull();
  });
});

describe("pushedBranch", () => {
  it("is the upstream's name on origin", () => {
    expect(pushedBranch(checkout())).toBe("feat/x");
    expect(pushedBranch(checkout({ branch: "local", upstream: "origin/other" }))).toBe("other");
  });

  it("is nothing unpushed, gone, or tracking another remote", () => {
    expect(pushedBranch(checkout({ upstream: null }))).toBeNull();
    expect(pushedBranch(checkout({ upstream_gone: true }))).toBeNull();
    expect(pushedBranch(checkout({ upstream: "fork/feat/x" }))).toBeNull();
  });
});

describe("comparison", () => {
  it("compares a pushed branch ahead of the default one", () => {
    expect(comparison(checkout())).toEqual({ base: "main", branch: "feat/x" });
  });

  it("has nothing to compare when level, unpushed, or on the default branch", () => {
    expect(comparison(checkout({ unmerged: ["origin/main", 0] }))).toBeNull();
    expect(comparison(checkout({ upstream: null }))).toBeNull();
    expect(comparison(checkout({ unmerged: null }))).toBeNull();
  });
});

it("opens only files the pushed branch has", () => {
  expect(["M", "D", "U"].every(onRemote)).toBe(true);
  expect(["A", "?", "R"].some(onRemote)).toBe(false);
});

describe("forgeDue", () => {
  const entry = { key: "b@1", status: null, at: 1000 };
  it("asks first, and again for another branch or commit", () => {
    expect(forgeDue(undefined, "b@1", 1000, false)).toBe(true);
    expect(forgeDue(entry, "b@2", 1001, false)).toBe(true);
  });

  it("waits out the gap unless forced", () => {
    expect(forgeDue(entry, "b@1", 1000 + FORGE_GAP_MS - 1, false)).toBe(false);
    expect(forgeDue(entry, "b@1", 1000 + FORGE_GAP_MS, false)).toBe(true);
    expect(forgeDue(entry, "b@1", 1001, true)).toBe(true);
  });
});
