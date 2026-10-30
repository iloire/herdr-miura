// Where a workspace belongs, and the tab header's warning when the focused
// pane is somewhere else. Herdr keeps no such folder: `new_workspace_cwd` is
// the active tab's focused pane, the `worktree` field has no path, and the
// folder a workspace was opened on never reaches the client. So the window
// fixes a root the first time it sees a workspace. Roots are keyed by the
// daemon's boot, since a restarted daemon may hand an old id to a new workspace.
//
// A prompt queue is kept on a main checkout, never on a worktree, which can be
// removed at any moment. Git says which checkout a worktree belongs to only
// while it exists, so each answer is kept in `homes`, outliving the worktree.

import type { ChangesState } from "../changes/store";
import type { Snapshot, Workspace } from "../protocol";
import { tildePath } from "./folder";
import { tabsFolder } from "./queue";
import { inside } from "./worktreeGroups";

const KEY = "workspace-roots";

export interface Roots {
  bootId: string;
  /// Each workspace's folder, by workspace id.
  folders: Record<string, string>;
  /// The queue's folder for each folder in use, as `queue_homes` answered.
  homes: Record<string, string>;
}

const NO_ROOTS: Roots = { bootId: "", folders: {}, homes: {} };

export function loadRoots(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Roots {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<Roots> | null;
    return typeof saved?.bootId === "string" && saved.folders ? { bootId: saved.bootId, folders: saved.folders, homes: saved.homes ?? {} } : NO_ROOTS;
  } catch {
    return NO_ROOTS;
  }
}

export function saveRoots(roots: Roots, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(roots));
  } catch {
    // Forgotten roots are found again from the tabs at the next launch.
  }
}

/// `roots` for this snapshot: a known workspace keeps its folder wherever its
/// panes go, and a new one starts on the folder most of its tabs are in, which
/// for a workspace just opened is the folder it was opened on. Closed
/// workspaces drop out. The same object comes back when nothing changed.
export function nextRoots(roots: Roots, snapshot: Snapshot): Roots {
  const sameBoot = roots.bootId === snapshot.boot_id;
  const folders: Record<string, string> = {};
  for (const workspace of snapshot.workspaces) {
    const id = workspace.workspace_id;
    const folder = (sameBoot ? roots.folders[id] : undefined) ?? tabsFolder(workspace, snapshot);
    if (folder) folders[id] = folder;
  }
  const ids = Object.keys(folders);
  const used = foldersInUse(folders, snapshot);
  const homes = Object.fromEntries(Object.entries(roots.homes).filter(([folder]) => used.has(folder)));
  const unchanged =
    sameBoot &&
    ids.length === Object.keys(roots.folders).length &&
    ids.every((id) => id in roots.folders) &&
    Object.keys(homes).length === Object.keys(roots.homes).length;
  return unchanged ? roots : { bootId: snapshot.boot_id, folders, homes };
}

function foldersInUse(folders: Record<string, string>, snapshot: Snapshot): Set<string> {
  const used = new Set(Object.values(folders));
  for (const workspace of snapshot.workspaces) {
    const folder = tabsFolder(workspace, snapshot);
    if (folder) used.add(folder);
  }
  return used;
}

/// The folders in use that have no home yet.
export function homelessFolders(roots: Roots, snapshot: Snapshot): string[] {
  return [...foldersInUse(roots.folders, snapshot)].filter((folder) => !(folder in roots.homes));
}

/// `roots` with the homes found; the same object when that adds nothing.
export function withHomes(roots: Roots, found: Map<string, string>): Roots {
  const added = [...found].filter(([folder, home]) => roots.homes[folder] !== home);
  return added.length ? { ...roots, homes: { ...roots.homes, ...Object.fromEntries(added) } } : roots;
}

/// The folder a workspace's queue is kept on: its root's main checkout, wherever
/// its tabs go. A root deleted before its home was asked has none, so the
/// folder most of its tabs are in stands in. Null until `homes` answers.
export function queueFolder(roots: Roots, workspace: Workspace, snapshot: Snapshot): string | null {
  const root = roots.folders[workspace.workspace_id];
  const home = root === undefined ? undefined : roots.homes[root];
  if (home !== undefined) return home;
  const tabs = tabsFolder(workspace, snapshot);
  return tabs === null ? null : (roots.homes[tabs] ?? null);
}

export interface StrayPath {
  /// Relative to the root inside it, else with the home folder as `~`.
  short: string;
  full: string;
}

/// Where the focused pane is when that is not the workspace's root, for the
/// tab header: its checkout's top level, or its directory outside Git. Quiet
/// on the root, in any subdirectory of the root's checkout, and when the root
/// lies inside the pane's checkout, as a workspace opened on a repo's
/// subfolder does. Like `tabGit`, a read of any other directory counts as
/// nothing, so a pane switch never flashes a path before its checkout is known.
export function strayPath(
  state: ChangesState,
  directory: string | null,
  root: string | null,
  home: string | null,
): StrayPath | null {
  if (state.phase !== "ready" || state.directory !== directory || !directory || !root) return null;
  const checkout = state.checkout?.path ?? null;
  const here = checkout ?? directory;
  if (here === root || (checkout && inside(root, checkout))) return null;
  const short = inside(here, root) ? here.slice(root.replace(/\/+$/, "").length + 1) : tildePath(here, home);
  return { short, full: here };
}
