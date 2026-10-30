import { describe, expect, it } from "vitest";
import type { Snapshot, Workspace } from "../../protocol";
import { countedDirectories } from "../../changes/counts";
import type { Worktree } from "../../changes/worktrees";
import { workspaceFolder } from "../queue";
import { type Roots, workspaceRoot } from "../workspaceRoot";
import { groupWorktrees, workspaceOn } from "../worktreeGroups";

function workspace(label: string, folder: string): Workspace {
  return {
    workspace_id: label,
    active_tab_id: `${label}:t1`,
    new_workspace_cwd: folder,
    number: 1,
    label,
    custom_label: false,
    branch: null,
    git_ahead_behind: null,
    tokens: [],
    worktree: null,
    focused: false,
    agent_status: "idle",
  };
}

function worktree(path: string): Worktree {
  return { path, branch: null, subject: null, time: null, base: null, unmerged: null, changed: null, repo: "/r", main: null, ahead: null };
}

const APP = "/code/app";
const FIX = "/code/app/.claude/worktrees/fix";
const UI = "/code/app/.claude/worktrees/ui";

/// Git lists the same linked worktrees from the main checkout and from each worktree.
function group(workspaces: Workspace[], lists: Record<string, string[]>) {
  return groupWorktrees(
    workspaces,
    (w) => w.new_workspace_cwd,
    (w) => (lists[w.new_workspace_cwd] ?? []).map(worktree),
  ).map((row) => [row.workspace.label, row.parent?.label ?? null]);
}

describe("groupWorktrees", () => {
  const lists = { [APP]: [FIX, UI], [FIX]: [FIX, UI], [UI]: [FIX, UI] };

  it("moves each worktree workspace to just under its main checkout's, keeping their order", () => {
    const rows = group(
      [workspace("ui", UI), workspace("notes", "/notes"), workspace("app", APP), workspace("fix", FIX)],
      lists,
    );
    expect(rows).toEqual([
      ["notes", null],
      ["app", null],
      ["ui", "app"],
      ["fix", "app"],
    ]);
  });

  it("leaves a worktree where it is when its main checkout has no workspace", () => {
    expect(group([workspace("fix", FIX), workspace("notes", "/notes")], lists)).toEqual([
      ["fix", null],
      ["notes", null],
    ]);
  });

  it("does not take a folder that only shares a prefix for one inside the worktree", () => {
    const rows = group([workspace("app", APP), workspace("fixed", `${FIX}ed`)], { [APP]: [FIX], [`${FIX}ed`]: [FIX] });
    expect(rows).toEqual([
      ["app", null],
      ["fixed", null],
    ]);
  });
});

describe("groupWorktrees on the card's lookups", () => {
  const NOTES = "/notes";
  const lists: Record<string, string[]> = { [APP]: [FIX], [FIX]: [FIX] };

  /// `folders` are the active tabs' folders, by label. The rows the sidebar
  /// draws: Git's lists read for `countedDirectories`, as App.tsx does, and
  /// the same folder lookup as Sidebar.tsx.
  function cards(folders: Record<string, string>, rooted: Record<string, string>) {
    const workspaces = Object.entries(folders).map(([label, folder]) => workspace(label, folder));
    const snapshot = {
      boot_id: "boot",
      workspaces,
      tabs: workspaces.map((w) => ({ tab_id: w.active_tab_id, workspace_id: w.workspace_id, number: 1 })),
      panes: workspaces.map((w) => ({ pane_id: `${w.label}:p`, tab_id: w.active_tab_id, cwd: w.new_workspace_cwd })),
    } as unknown as Snapshot;
    const roots: Roots = { bootId: "boot", folders: rooted, homes: {} };
    const rootOf = (w: Workspace) => workspaceRoot(roots, w, snapshot);
    const { byWorkspace } = countedDirectories(snapshot, rootOf);
    return groupWorktrees(
      workspaces,
      (w) => rootOf(w) ?? workspaceFolder(w, snapshot),
      (w) => (lists[byWorkspace.get(w.workspace_id) ?? ""] ?? []).map(worktree),
    ).map((row) => [row.workspace.label, row.parent?.label ?? null]);
  }

  it("does not take a non-repo workspace for a main checkout because its active tab is in one", () => {
    expect(cards({ notes: APP, fix: FIX }, { notes: NOTES, fix: FIX })).toEqual([
      ["notes", null],
      ["fix", null],
    ]);
  });

  it("does not nest a main checkout under another because its active tab is in a worktree", () => {
    expect(cards({ app: FIX, notes: APP }, { app: APP, notes: NOTES })).toEqual([
      ["app", null],
      ["notes", null],
    ]);
  });

  it("still nests a real main checkout and its worktree", () => {
    expect(cards({ fix: FIX, notes: NOTES, app: APP }, { fix: FIX, notes: NOTES, app: APP })).toEqual([
      ["notes", null],
      ["app", null],
      ["fix", "app"],
    ]);
  });

  it("falls back to the active tab's folder for a workspace with no root yet", () => {
    expect(cards({ fix: FIX, app: APP }, {})).toEqual([
      ["app", null],
      ["fix", "app"],
    ]);
  });
});

describe("workspaceOn", () => {
  const folderOf = (w: Workspace) => w.new_workspace_cwd;

  it("finds the workspace open on a worktree, or in a folder inside it", () => {
    const fix = workspace("fix", FIX);
    const deep = workspace("deep", `${UI}/src`);
    const all = [workspace("app", APP), fix, deep];
    expect(workspaceOn(worktree(FIX), all, folderOf)).toBe(fix);
    expect(workspaceOn(worktree(UI), all, folderOf)).toBe(deep);
  });

  it("does not take the main checkout for a worktree inside it, or a neighbor for it", () => {
    expect(workspaceOn(worktree(FIX), [workspace("app", APP)], folderOf)).toBeNull();
    expect(workspaceOn(worktree(FIX), [workspace("other", `${FIX}-other`)], folderOf)).toBeNull();
  });

  it("skips a workspace with no folder", () => {
    expect(workspaceOn(worktree(FIX), [workspace("app", APP)], () => null)).toBeNull();
  });
});
