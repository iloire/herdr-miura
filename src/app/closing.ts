// Tabs on their way out. Herdr answers `tab.close` only once the tab's process
// has exited, which takes a moment for one that traps SIGHUP to clean up, as
// agents and dev servers do; the window hides the tab the moment it is closed
// instead of waiting for that.

import type { Snapshot, Tab } from "../protocol";

/// `snapshot` without the tabs in `closing`, or their panes.
export function withoutClosing(snapshot: Snapshot, closing: ReadonlySet<string>): Snapshot {
  if (closing.size === 0) return snapshot;
  return {
    ...snapshot,
    tabs: snapshot.tabs.filter((tab) => !closing.has(tab.tab_id)),
    panes: snapshot.panes.filter((pane) => !closing.has(pane.tab_id)),
  };
}

/// The tab Herdr focuses once `tab` closes: the one before it in its
/// workspace, or after it for the first. Null for a workspace's last tab.
export function focusAfterClose(tabs: readonly Tab[], tab: Tab): Tab | null {
  const siblings = tabs.filter((other) => other.workspace_id === tab.workspace_id);
  const index = siblings.findIndex((other) => other.tab_id === tab.tab_id);
  if (index === -1) return null;
  return siblings[index - 1] ?? siblings[index + 1] ?? null;
}
