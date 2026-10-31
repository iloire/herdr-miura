// Previous and next workspace. Herdr's catalog leaves them to the window, since
// they follow the sidebar's rows rather than anything in the snapshot.

import type { Agent, Workspace } from "../protocol";
import { loadSort, sortWorkspaces, type WorkspaceSort } from "./workspaceOrder";

/// The workspace `delta` rows from the focused one, wrapping around, in the
/// order the sidebar lists them (`sort`, by default the one it saved). With
/// none focused, previous starts from the last row and next from the first, as
/// herdr-gpui's sidebar steps.
export function stepWorkspace(
  listed: readonly Workspace[],
  agents: readonly Agent[],
  focusedId: string | null,
  delta: 1 | -1,
  sort: WorkspaceSort = loadSort(),
): Workspace | null {
  const workspaces = sortWorkspaces(listed, sort, agents);
  const length = workspaces.length;
  if (length === 0) return null;
  const current = workspaces.findIndex((workspace) => workspace.workspace_id === focusedId);
  if (current === -1) return workspaces[delta === 1 ? 0 : length - 1];
  return workspaces[(current + delta + length) % length];
}
