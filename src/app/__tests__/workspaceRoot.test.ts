import { describe, expect, it } from "vitest";
import type { CheckoutChanges, ChangesState } from "../../changes/store";
import type { Snapshot, Workspace } from "../../protocol";
import { queueDirectory, splitQueueFolder } from "../queue";
import { homelessFolders, isOpenSplit, loadRoots, nextRoots, queueFolder, type Roots, saveRoots, strayPath, withHomes, withSplit, workspaceRoot } from "../workspaceRoot";

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

function snapshot(boot_id: string, tabs: Record<string, string[]>, agentsIn: string[] = []): Snapshot {
  const ids = Object.keys(tabs);
  return {
    boot_id,
    workspaces: ids.map((workspace_id) => ({ workspace_id, new_workspace_cwd: "/follows/the/focus" })),
    tabs: ids.flatMap((w) => tabs[w].map((_, i) => ({ tab_id: `${w}:${i}`, workspace_id: w, number: i + 1 }))),
    panes: ids.flatMap((w) =>
      tabs[w].map((cwd, i) => ({ pane_id: `${w}:p${i}`, workspace_id: w, tab_id: `${w}:${i}`, cwd, foreground_cwd: cwd })),
    ),
    agents: agentsIn.map((workspace_id) => ({ workspace_id })),
  } as unknown as Snapshot;
}

describe("nextRoots", () => {
  const none: Roots = { bootId: "", folders: {}, homes: {}, split: {} };

  it("starts a workspace on the folder most of its tabs are in, not the focus", () => {
    const roots = nextRoots(none, snapshot("boot", { w1: ["/app", "/elsewhere", "/app"] }));
    expect(roots).toEqual({ bootId: "boot", folders: { w1: "/app" }, homes: {}, split: {} });
  });

  it("keeps a workspace's root when an agent's only pane moves", () => {
    const first = nextRoots(none, snapshot("boot", { w1: ["/app"] }, ["w1"]));
    const moved = nextRoots(first, snapshot("boot", { w1: ["/app/.claude/worktrees/foo"] }, ["w1"]));
    expect(moved).toBe(first);
  });

  it("keeps a workspace's root when a tab of several moves", () => {
    const first = nextRoots(none, snapshot("boot", { w1: ["/app", "/app"] }));
    expect(nextRoots(first, snapshot("boot", { w1: ["/app", "/other"] }))).toBe(first);
  });

  it("follows the one shell of a new workspace to where it was cd'd", () => {
    const opened = nextRoots(none, snapshot("boot", { w1: ["/source"] }));
    const moved = nextRoots(opened, snapshot("boot", { w1: ["/venturi"] }));
    expect(moved.folders).toEqual({ w1: "/venturi" });
  });

  it("stays where the shell was when an agent or a second tab starts there", () => {
    const opened = nextRoots(none, snapshot("boot", { w1: ["/source"] }));
    const moved = nextRoots(opened, snapshot("boot", { w1: ["/venturi"] }));
    const agent = nextRoots(moved, snapshot("boot", { w1: ["/elsewhere"] }, ["w1"]));
    expect(agent.folders).toEqual({ w1: "/venturi" });
    const tab = nextRoots(moved, snapshot("boot", { w1: ["/elsewhere", "/venturi"] }));
    expect(tab.folders).toEqual({ w1: "/venturi" });
  });

  it("gives a workspace opened later its own folder and drops a closed one", () => {
    const first = nextRoots(none, snapshot("boot", { w1: ["/a"], w2: ["/b"] }));
    expect(nextRoots(first, snapshot("boot", { w2: ["/moved"], w3: ["/c"] }, ["w2"])).folders).toEqual({ w2: "/b", w3: "/c" });
  });

  it("starts over on a new boot, whose ids mean other workspaces", () => {
    const first = nextRoots(none, snapshot("old", { w1: ["/a"] }));
    expect(nextRoots(first, snapshot("new", { w1: ["/b"] }))).toEqual({ bootId: "new", folders: { w1: "/b" }, homes: {}, split: {} });
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
    const roots = { bootId: "boot", folders: { w1: "/a" }, homes: { "/a": "/a" }, split: {} };
    saveRoots(roots, { setItem: (_, value) => (saved = value) });
    expect(loadRoots(store(saved))).toEqual(roots);
  });

  it("reads roots saved before homes existed", () => {
    expect(loadRoots(store('{"bootId":"boot","folders":{"w1":"/a"}}')).homes).toEqual({});
  });

  it("starts empty on nothing saved or a damaged value", () => {
    expect(loadRoots(store(null)).folders).toEqual({});
    expect(loadRoots(store("{nope")).folders).toEqual({});
    expect(loadRoots(store("[]")).folders).toEqual({});
  });
});

const MAIN = "/code/app";
const TREE = "/code/app/.claude/worktrees/agent-age";

// A workspace with one tab in each folder, the first tab's pane first.
function shot(...folders: string[]): { snapshot: Snapshot; workspace: Workspace } {
  const workspace = { workspace_id: "w1", new_workspace_cwd: "", active_tab_id: "t0" } as Workspace;
  const snapshot = {
    boot_id: "boot",
    workspaces: [workspace],
    tabs: folders.map((_, number) => ({ tab_id: `t${number}`, workspace_id: "w1", number })),
    panes: folders.map((cwd, i) => ({ pane_id: `p${i}`, tab_id: `t${i}`, cwd })),
    agents: [],
  } as unknown as Snapshot;
  return { snapshot, workspace };
}

const rootedOn = (folder: string, homes: Record<string, string> = {}): Roots => ({
  bootId: "boot",
  folders: { w1: folder },
  homes,
  split: {},
});

describe("workspaceRoot", () => {
  it("is the fixed root wherever the tabs are, and nothing before one is fixed", () => {
    const { snapshot, workspace } = shot("/elsewhere");
    expect(workspaceRoot(rootedOn(MAIN), workspace, snapshot)).toBe(MAIN);
    expect(workspaceRoot({ bootId: "boot", folders: {}, homes: {}, split: {} }, workspace, snapshot)).toBeNull();
  });

  it("ignores roots saved under another boot, whose ids name other workspaces", () => {
    const { snapshot, workspace } = shot(MAIN);
    expect(workspaceRoot({ ...rootedOn("/old"), bootId: "earlier" }, workspace, snapshot)).toBeNull();
  });
});

describe("queueFolder", () => {
  it("keeps a worktree's queue on its main checkout", () => {
    const { snapshot, workspace } = shot(TREE);
    expect(queueFolder(rootedOn(TREE, { [TREE]: MAIN }), workspace, snapshot)).toBe(MAIN);
  });

  it("does not follow the tabs away from the root", () => {
    const { snapshot, workspace } = shot("/other", "/other");
    expect(queueFolder(rootedOn(MAIN, { [MAIN]: MAIN, "/other": "/other" }), workspace, snapshot)).toBe(MAIN);
  });

  it("stays on the main checkout once the worktree is gone", () => {
    const { snapshot, workspace } = shot(MAIN);
    const before = rootedOn(TREE, { [TREE]: MAIN, [MAIN]: MAIN });
    expect(queueFolder(nextRoots(before, snapshot), workspace, snapshot)).toBe(MAIN);
  });

  it("uses the tabs when the root was gone before it could be asked", () => {
    const { snapshot, workspace } = shot(MAIN);
    expect(queueFolder(rootedOn(TREE, { [MAIN]: MAIN }), workspace, snapshot)).toBe(MAIN);
  });

  it("is unknown until Git has answered, never the worktree itself", () => {
    const { snapshot, workspace } = shot(TREE);
    expect(queueFolder(rootedOn(TREE), workspace, snapshot)).toBeNull();
  });
});

describe("a workspace split off a tab", () => {
  const SPLIT_ROOT = "/code/app/packages/docs";
  // An agent keeps the root once fixed; the first tab of the workspace is elsewhere.
  const settled = (snapshot: Snapshot) =>
    ({ ...snapshot, agents: [{ pane_id: "p0", workspace_id: "w1", tab_id: "t0" }] }) as unknown as Snapshot;

  it("has a queue of its own though it shares its source's folder", () => {
    const { snapshot, workspace } = shot(MAIN);
    const source = rootedOn(MAIN, { [MAIN]: MAIN });
    expect(queueFolder(source, workspace, snapshot)).toBe(MAIN);
    const split = withSplit(source, "w1", MAIN);
    expect(queueFolder(split, workspace, snapshot)).toBe(splitQueueFolder(MAIN, "w1"));
    expect(queueDirectory(queueFolder(split, workspace, snapshot) ?? "")).toBe(MAIN);
  });

  it("keeps the tab's folder as its root, not the folder of its first pane", () => {
    const { snapshot } = shot(MAIN);
    const next = nextRoots(withSplit(rootedOn(MAIN), "w1", SPLIT_ROOT), settled(snapshot));
    expect(next.folders.w1).toBe(SPLIT_ROOT);
  });

  it("survives a snapshot from before the workspace showed", () => {
    const { snapshot } = shot(MAIN);
    const early = nextRoots(withSplit(rootedOn(MAIN), "w2", SPLIT_ROOT), snapshot);
    expect(early.folders.w2).toBeUndefined();
    const workspace = { workspace_id: "w2", new_workspace_cwd: "", active_tab_id: "t9" } as Workspace;
    const shown = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, workspace],
      tabs: [...snapshot.tabs, { tab_id: "t9", workspace_id: "w2", number: 1 }],
      panes: [...snapshot.panes, { pane_id: "p9", workspace_id: "w2", tab_id: "t9", cwd: MAIN }],
      agents: [{ pane_id: "p9", workspace_id: "w2", tab_id: "t9" }],
    } as unknown as Snapshot;
    const next = nextRoots(early, shown);
    expect(next.folders.w2).toBe(SPLIT_ROOT);
    expect(isOpenSplit(next, "w2", shown)).toBe(true);
  });

  it("ends with the daemon's boot, or when it closes", () => {
    const { snapshot, workspace } = shot(MAIN);
    const split = withSplit(rootedOn(MAIN, { [MAIN]: MAIN }), "w1", MAIN);
    expect(isOpenSplit(split, "w1", snapshot)).toBe(true);
    expect(isOpenSplit(split, "w1", { ...snapshot, workspaces: [] })).toBe(false);
    const reborn = { ...snapshot, boot_id: "new" };
    expect(isOpenSplit(split, "w1", reborn)).toBe(false);
    expect(queueFolder(split, workspace, reborn)).toBe(MAIN);
    expect(nextRoots(split, reborn).split).toEqual({});
  });

  it("is remembered across launches, and missing from what older builds saved", () => {
    const store = (value: string) => ({ getItem: () => value });
    const split = withSplit(rootedOn(MAIN), "w1", MAIN);
    expect(loadRoots(store(JSON.stringify(split))).split).toEqual({ w1: MAIN });
    expect(loadRoots(store('{"bootId":"boot","folders":{}}')).split).toEqual({});
  });
});

describe("homes", () => {
  it("asks for the root and the tabs' folder, once each", () => {
    const { snapshot } = shot(MAIN);
    expect(homelessFolders(rootedOn(TREE), snapshot)).toEqual([TREE, MAIN]);
    expect(homelessFolders(rootedOn(MAIN), snapshot)).toEqual([MAIN]);
    expect(homelessFolders(rootedOn(MAIN, { [MAIN]: MAIN }), snapshot)).toEqual([]);
  });

  it("forgets folders no workspace uses", () => {
    const { snapshot } = shot(MAIN);
    const next = nextRoots(rootedOn(MAIN, { [MAIN]: MAIN, "/old": "/old" }), snapshot);
    expect(next.homes).toEqual({ [MAIN]: MAIN });
  });

  it("leaves the same object when nothing changed", () => {
    const { snapshot } = shot(MAIN);
    const same = rootedOn(MAIN, { [MAIN]: MAIN });
    expect(nextRoots(same, snapshot)).toBe(same);
    expect(withHomes(same, new Map([[MAIN, MAIN]]))).toBe(same);
  });
});
