// How the sidebar orders workspaces: by hand, which is the daemon's own list
// (rows dragged into place reorder it with `workspace.move`), or by what needs
// you first. The choice is this window's, kept in its storage.

import type { Workspace } from "../protocol";
import { PRIORITY } from "./attention";

export type WorkspaceSort = "manual" | "attention";

const KEY = "workspace-sort";

export function loadSort(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): WorkspaceSort {
  try {
    return storage?.getItem(KEY) === "attention" ? "attention" : "manual";
  } catch {
    return "manual";
  }
}

export function saveSort(sort: WorkspaceSort, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, sort);
  } catch {
    // A sort that is not remembered is only a convenience lost.
  }
}

/// `workspaces` as the sidebar lists them. By attention: blocked, done,
/// working, idle, each status keeping the daemon's order.
export function sortWorkspaces(workspaces: readonly Workspace[], sort: WorkspaceSort): Workspace[] {
  if (sort === "manual") return [...workspaces];
  return [...workspaces].sort((a, b) => PRIORITY[b.agent_status] - PRIORITY[a.agent_status]);
}

/// The gap a pointer at `y` is over, 0 (before the first row) to `rows.length`
/// (after the last), split at each row's middle.
export function dropSlot(y: number, rows: readonly { top: number; height: number }[]): number {
  const index = rows.findIndex((row) => y < row.top + row.height / 2);
  return index === -1 ? rows.length : index;
}

/// `workspace.move`'s `insert_index` for the row at `from` dropped in gap
/// `slot`: Herdr counts it with the workspace still in place. Null when the
/// gap is on either side of the row itself, so nothing would move.
export function moveIndex(from: number, slot: number): number | null {
  return slot === from || slot === from + 1 ? null : slot;
}
