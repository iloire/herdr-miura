// Workspaces opened on a linked worktree sit under the workspace of the
// checkout they came from, so the two read as one piece of work. Herdr's own
// `worktree` field is empty for workspaces it did not make, so the pairing
// comes from Git: the linked worktrees `worktrees.rs` lists for each
// workspace's checkout.

import type { Workspace } from "../protocol";
import type { Worktree } from "../changes/worktrees";

export interface Row {
  workspace: Workspace;
  /// The workspace of the main checkout this one is a worktree of, when that is open too.
  parent: Workspace | null;
}

/// `folder` is `path` or a folder inside it.
export function inside(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(path.endsWith("/") ? path : `${path}/`);
}

/// The workspace open on `worktree`, if any.
export function workspaceOn(
  worktree: Worktree,
  workspaces: readonly Workspace[],
  folderOf: (workspace: Workspace) => string | null,
): Workspace | null {
  return (
    workspaces.find((workspace) => {
      const folder = folderOf(workspace);
      return folder !== null && inside(folder, worktree.path);
    }) ?? null
  );
}

/// `workspaces` in their order, each one on a linked worktree moved to just
/// after the workspace of its main checkout, keeping their own order there.
/// A worktree whose main checkout has no workspace stays where it was.
export function groupWorktrees(
  workspaces: readonly Workspace[],
  folderOf: (workspace: Workspace) => string | null,
  worktreesOf: (workspace: Workspace) => readonly Worktree[],
): Row[] {
  // On a linked worktree: its folder is in one its own checkout lists.
  const linked = (workspace: Workspace) => {
    const folder = folderOf(workspace);
    return folder !== null && worktreesOf(workspace).some((worktree) => inside(folder, worktree.path));
  };
  const parentOf = (child: Workspace): Workspace | null => {
    const folder = folderOf(child);
    if (folder === null || !linked(child)) return null;
    return (
      workspaces.find(
        (candidate) =>
          candidate !== child &&
          !linked(candidate) &&
          worktreesOf(candidate).some((worktree) => inside(folder, worktree.path)),
      ) ?? null
    );
  };
  const parents = new Map(workspaces.map((workspace) => [workspace, parentOf(workspace)]));
  const rows: Row[] = [];
  for (const workspace of workspaces) {
    if (parents.get(workspace)) continue;
    rows.push({ workspace, parent: null });
    for (const child of workspaces) {
      if (parents.get(child) === workspace) rows.push({ workspace: child, parent: workspace });
    }
  }
  return rows;
}
