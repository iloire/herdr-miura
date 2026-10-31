// Tabs on their way out. Herdr answers `tab.close` only once the tab's process
// has exited, which takes a moment for one that traps SIGHUP to clean up, as
// agents and dev servers do; the window hides the tab the moment it is closed
// instead of waiting for that.
//
// That hang-up stops an agent mid-task, and with it whatever it is running or a
// queued prompt's run, so the window asks first. `window.confirm` cannot ask:
// wry gives WKWebView no JavaScript confirm handler, and without one it answers
// as if Cancel was pressed, with no dialog.

import type { Agent, Snapshot, Tab } from "../protocol";
import { busy } from "./queue";

/// A close held until the user answers.
export interface CloseAsk {
  method: string;
  params: Record<string, unknown>;
  /// The tab's label, or "this pane".
  name: string;
  kind: "Tab" | "Pane";
  /// Who would be stopped mid-task.
  agents: string[];
}

const stopped = (agents: Agent[]) => agents.filter(busy).map((agent) => agent.display_agent ?? agent.agent ?? "An agent");

/// What to ask before this request, or null if it stops no agent mid-task: a
/// tab counts all its agents, a pane only its own. Herdr reports agents, not
/// other processes, so a shell or a server closes without asking.
export function closeAsk(snapshot: Snapshot, method: string, params: Record<string, unknown>): CloseAsk | null {
  if (method === "tab.close") {
    const tab = snapshot.tabs.find((t) => t.tab_id === params.tab_id);
    const agents = stopped(snapshot.agents.filter((agent) => agent.tab_id === tab?.tab_id));
    return tab && agents.length ? { method, params, name: tab.label, kind: "Tab", agents } : null;
  }
  if (method === "pane.close") {
    const agents = stopped(snapshot.agents.filter((agent) => agent.pane_id === params.pane_id));
    return agents.length ? { method, params, name: "this pane", kind: "Pane", agents } : null;
  }
  return null;
}

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
