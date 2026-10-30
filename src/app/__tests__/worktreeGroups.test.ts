import { describe, expect, it } from "vitest";
import type { Workspace } from "../../protocol";
import type { Worktree } from "../../changes/worktrees";
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
  return { path, branch: null, subject: null, time: null, base: null, unmerged: null, changed: null };
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
