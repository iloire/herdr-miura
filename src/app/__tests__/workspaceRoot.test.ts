import { describe, expect, it } from "vitest";
import type { CheckoutChanges, ChangesState } from "../../changes/store";
import type { Snapshot } from "../../protocol";
import { loadRoots, nextRoots, type Roots, saveRoots, strayPath } from "../workspaceRoot";

const HOME = "/Users/me";
const ROOT = "/Users/me/code/app";

const ready = (directory: string, path: string | null): ChangesState => ({
  phase: "ready",
  directory,
  checkout: path ? ({ path } as CheckoutChanges) : null,
  at: 0,
});

describe("strayPath", () => {
  it("is quiet on the root", () => {
    expect(strayPath(ready(ROOT, ROOT), ROOT, ROOT, HOME)).toBeNull();
  });

  it("is quiet in a subdirectory of the same checkout", () => {
    expect(strayPath(ready(`${ROOT}/src`, ROOT), `${ROOT}/src`, ROOT, HOME)).toBeNull();
  });

  it("is quiet when the root lies inside the checkout", () => {
    expect(strayPath(ready(`${ROOT}/ui`, ROOT), `${ROOT}/ui`, `${ROOT}/ui/web`, HOME)).toBeNull();
    expect(strayPath(ready(ROOT, ROOT), ROOT, `${ROOT}/ui`, HOME)).toBeNull();
  });

  it("shows a worktree inside the root relative to it", () => {
    const worktree = `${ROOT}/.claude/worktrees/foo`;
    expect(strayPath(ready(`${worktree}/src`, worktree), `${worktree}/src`, ROOT, HOME)).toEqual({
      short: ".claude/worktrees/foo",
      full: worktree,
    });
  });

  it("shows a checkout elsewhere with ~ for the home folder", () => {
    const other = "/Users/me/code/other-repo";
    expect(strayPath(ready(other, other), other, ROOT, HOME)).toEqual({ short: "~/code/other-repo", full: other });
    expect(strayPath(ready("/srv/repo", "/srv/repo"), "/srv/repo", ROOT, HOME)?.short).toBe("/srv/repo");
  });

  it("does not take a sibling sharing the root's prefix for inside it", () => {
    const sibling = `${ROOT}-old`;
    expect(strayPath(ready(sibling, sibling), sibling, ROOT, HOME)?.short).toBe("~/code/app-old");
  });

  it("uses the pane's directory outside Git", () => {
    expect(strayPath(ready("/tmp/x", null), "/tmp/x", ROOT, HOME)).toEqual({ short: "/tmp/x", full: "/tmp/x" });
    expect(strayPath(ready(ROOT, null), ROOT, ROOT, HOME)).toBeNull();
    expect(strayPath(ready(`${ROOT}/logs`, null), `${ROOT}/logs`, ROOT, HOME)?.short).toBe("logs");
  });

  it("does not treat a plain parent of the root as containing it", () => {
    expect(strayPath(ready("/Users/me/code", null), "/Users/me/code", ROOT, HOME)?.short).toBe("~/code");
  });

  it("is relative to a root at the filesystem's top", () => {
    expect(strayPath(ready("/srv/repo", "/srv/repo"), "/srv/repo", "/", HOME)?.short).toBe("srv/repo");
  });

  it("says nothing until the read of this directory is in", () => {
    const other = "/Users/me/code/other-repo";
    expect(strayPath({ phase: "loading", directory: other }, other, ROOT, HOME)).toBeNull();
    expect(strayPath({ phase: "failed", directory: other, error: "x" }, other, ROOT, HOME)).toBeNull();
    expect(strayPath(ready(ROOT, ROOT), other, ROOT, HOME)).toBeNull();
  });

  it("says nothing without a directory or a root", () => {
    expect(strayPath(ready(ROOT, ROOT), null, ROOT, HOME)).toBeNull();
    expect(strayPath(ready(ROOT, ROOT), ROOT, null, HOME)).toBeNull();
  });
});

function snapshot(boot_id: string, tabs: Record<string, string[]>): Snapshot {
  const ids = Object.keys(tabs);
  return {
    boot_id,
    workspaces: ids.map((workspace_id) => ({ workspace_id, new_workspace_cwd: "/follows/the/focus" })),
    tabs: ids.flatMap((w) => tabs[w].map((_, i) => ({ tab_id: `${w}:${i}`, workspace_id: w, number: i + 1 }))),
    panes: ids.flatMap((w) =>
      tabs[w].map((cwd, i) => ({ pane_id: `${w}:p${i}`, tab_id: `${w}:${i}`, cwd, foreground_cwd: cwd })),
    ),
  } as unknown as Snapshot;
}

describe("nextRoots", () => {
  const none: Roots = { bootId: "", folders: {} };

  it("starts a workspace on the folder most of its tabs are in, not the focus", () => {
    const roots = nextRoots(none, snapshot("boot", { w1: ["/app", "/elsewhere", "/app"] }));
    expect(roots).toEqual({ bootId: "boot", folders: { w1: "/app" } });
  });

  it("keeps a workspace's root when its only pane moves", () => {
    const first = nextRoots(none, snapshot("boot", { w1: ["/app"] }));
    const moved = nextRoots(first, snapshot("boot", { w1: ["/app/.claude/worktrees/foo"] }));
    expect(moved).toBe(first);
  });

  it("gives a workspace opened later its own folder and drops a closed one", () => {
    const first = nextRoots(none, snapshot("boot", { w1: ["/a"], w2: ["/b"] }));
    expect(nextRoots(first, snapshot("boot", { w2: ["/moved"], w3: ["/c"] })).folders).toEqual({ w2: "/b", w3: "/c" });
  });

  it("starts over on a new boot, whose ids mean other workspaces", () => {
    const first = nextRoots(none, snapshot("old", { w1: ["/a"] }));
    expect(nextRoots(first, snapshot("new", { w1: ["/b"] }))).toEqual({ bootId: "new", folders: { w1: "/b" } });
  });

  it("waits for a workspace's panes before fixing its root", () => {
    const empty = { ...snapshot("boot", { w1: [] }), panes: [] };
    expect(nextRoots(none, empty).folders).toEqual({});
  });
});

describe("roots storage", () => {
  const store = (value: string | null) => ({ getItem: () => value });

  it("round-trips", () => {
    let saved: string | null = null;
    const roots = { bootId: "boot", folders: { w1: "/a" } };
    saveRoots(roots, { setItem: (_, value) => (saved = value) });
    expect(loadRoots(store(saved))).toEqual(roots);
  });

  it("starts empty on nothing saved or a damaged value", () => {
    expect(loadRoots(store(null)).folders).toEqual({});
    expect(loadRoots(store("{nope")).folders).toEqual({});
    expect(loadRoots(store("[]")).folders).toEqual({});
  });
});
