import { invoke } from "@tauri-apps/api/core";
import type { Snapshot, Workspace } from "../protocol";

/// The directory a workspace is working in: its active tab's first pane,
/// where its program is, else where the daemon would open a new pane.
export function workspaceDirectory(workspace: Workspace, snapshot: Snapshot): string | null {
  const pane = snapshot.panes.find((p) => p.tab_id === workspace.active_tab_id);
  return pane?.foreground_cwd || pane?.cwd || workspace.new_workspace_cwd || null;
}

/// Each workspace's directory, with workspaces in the same folder asking once.
export function countedDirectories(snapshot: Snapshot): { byWorkspace: Map<string, string>; directories: string[] } {
  const byWorkspace = new Map<string, string>();
  for (const workspace of snapshot.workspaces) {
    const directory = workspaceDirectory(workspace, snapshot);
    if (directory) byWorkspace.set(workspace.workspace_id, directory);
  }
  return { byWorkspace, directories: [...new Set(byWorkspace.values())] };
}

/// How many files each directory's checkout has changed; `null` outside Git.
export async function readCounts(directories: string[]): Promise<Map<string, number | null>> {
  const counts = await invoke<(number | null)[]>("change_counts", { directories });
  return new Map(directories.map((directory, i) => [directory, counts[i] ?? null]));
}
