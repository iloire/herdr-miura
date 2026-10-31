// What the tab menu's Move to Workspace offers, and what a move sends. The
// move itself is `tab_move.rs`.

import type { Snapshot, Tab, Workspace } from "../protocol";
import { tabDirectory } from "./sharedCheckout";

export interface MoveChoices {
  others: Workspace[];
  /// A tab alone in its workspace would only rename it.
  canSplit: boolean;
}

export function moveChoices(tab: Tab, snapshot: Snapshot | null): MoveChoices {
  const others = snapshot?.workspaces.filter((workspace) => workspace.workspace_id !== tab.workspace_id) ?? [];
  const siblings = snapshot?.tabs.filter((other) => other.workspace_id === tab.workspace_id) ?? [];
  return { others, canSplit: siblings.length > 1 };
}

/// The name a new workspace is offered: the title the tab shows.
export const splitName = (tab: Tab) => tab.label;

export interface TabMove {
  panes: string[];
  /// Kept only when the tab was named: Herdr numbers one that wasn't.
  label: string | null;
  /// The tab's own folder, which can differ from its workspace's.
  folder: string | null;
}

export function tabMove(tab: Tab, snapshot: Snapshot): TabMove {
  return {
    panes: snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id).map((pane) => pane.pane_id),
    label: tab.custom_label ? tab.label : null,
    folder: tabDirectory(tab, snapshot),
  };
}
