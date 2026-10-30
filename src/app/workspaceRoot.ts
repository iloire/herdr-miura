// Where a workspace belongs, and the tab header's warning when the focused
// pane is somewhere else. Herdr keeps no such folder: `new_workspace_cwd` is
// the active tab's focused pane, the `worktree` field has no path, and the
// folder a workspace was opened on never reaches the client. So the window
// fixes a root the first time it sees a workspace. Roots are keyed by the
// daemon's boot, since a restarted daemon may hand an old id to a new workspace.

import type { ChangesState } from "../changes/store";
import type { Snapshot } from "../protocol";
import { tildePath } from "./folder";
import { tabsFolder } from "./queue";
import { inside } from "./worktreeGroups";

const KEY = "workspace-roots";

export interface Roots {
  bootId: string;
  /// Each workspace's folder, by workspace id.
  folders: Record<string, string>;
}

const NO_ROOTS: Roots = { bootId: "", folders: {} };

export function loadRoots(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Roots {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<Roots> | null;
    return typeof saved?.bootId === "string" && saved.folders ? { bootId: saved.bootId, folders: saved.folders } : NO_ROOTS;
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
  const unchanged =
    sameBoot && ids.length === Object.keys(roots.folders).length && ids.every((id) => id in roots.folders);
  return unchanged ? roots : { bootId: snapshot.boot_id, folders };
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
