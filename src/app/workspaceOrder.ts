// How the sidebar orders workspaces: by hand, which is the daemon's own list
// (rows dragged into place reorder it with `workspace.move`), or by what needs
// you first. The choice is this window's, kept in its storage.

import type { Agent, Workspace } from "../protocol";
import { outcomeNeedsYou, PRIORITY } from "./attention";

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
/// working, idle, each status keeping the daemon's order. A finished agent that
/// needs you ranks its workspace with the blocked ones, which the daemon's
/// status for it cannot say.
export function sortWorkspaces(workspaces: readonly Workspace[], sort: WorkspaceSort, agents: readonly Agent[]): Workspace[] {
  if (sort === "manual") return [...workspaces];
  const waiting = new Set(agents.filter(outcomeNeedsYou).map((agent) => agent.workspace_id));
  const rank = (workspace: Workspace) => PRIORITY[waiting.has(workspace.workspace_id) ? "blocked" : workspace.agent_status];
  return [...workspaces].sort((a, b) => rank(b) - rank(a));
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
