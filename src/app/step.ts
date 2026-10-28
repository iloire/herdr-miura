// Previous and next workspace. Herdr's catalog leaves them to the window, since
// they follow the sidebar's rows rather than anything in the snapshot.

import type { Workspace } from "../protocol";

/// The workspace `delta` rows from the focused one, wrapping around. With none
/// focused, previous starts from the last row and next from the first, as
/// herdr-gpui's sidebar steps.
export function stepWorkspace(
  workspaces: readonly Workspace[],
  focusedId: string | null,
  delta: 1 | -1,
): Workspace | null {
  const length = workspaces.length;
  if (length === 0) return null;
  const current = workspaces.findIndex((workspace) => workspace.workspace_id === focusedId);
  if (current === -1) return workspaces[delta === 1 ? 0 : length - 1];
  return workspaces[(current + delta + length) % length];
}
