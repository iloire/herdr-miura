// What needs you, read only from the daemon snapshot's agent statuses, never
// guessed from terminal output. Ordering and counting follow herdr-gpui.

import { clean } from "../changes/diff";
import type { Agent, AgentStatus, Snapshot } from "../protocol";

/// Attention first, then the most recent change (herdr-gpui's `status_priority`).
const PRIORITY: Record<AgentStatus, number> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/// The agents of each workspace, most urgent first, keeping the daemon's
/// order within a status.
export function agentsByWorkspace(snapshot: Snapshot): Map<string, Agent[]> {
  const byWorkspace = new Map<string, Agent[]>();
  for (const agent of snapshot.agents) {
    const list = byWorkspace.get(agent.workspace_id) ?? [];
    list.push(agent);
    byWorkspace.set(agent.workspace_id, list);
  }
  for (const list of byWorkspace.values()) {
    list.sort((a, b) => PRIORITY[b.agent_status] - PRIORITY[a.agent_status]);
  }
  return byWorkspace;
}

/// How many agents are waiting on you.
export function blockedCount(agents: readonly Agent[]): number {
  return agents.filter((agent) => agent.agent_status === "blocked").length;
}

/// The Dock badge: agents that finished or are waiting for input. Done ones
/// clear when the daemon marks them seen, blocked ones when their status moves.
export function attentionCount(snapshot: Snapshot | null): number {
  return snapshot?.agents.filter((a) => a.agent_status === "blocked" || a.agent_status === "done").length ?? 0;
}

/// The name a person would call an agent by, in herdr-gpui's order.
export function agentName(agent: Agent): string {
  return agent.display_agent || agent.name || agent.agent || agent.title || "agent";
}

/// What tells an agent apart from its neighbours under the same workspace:
/// its tab when that earns a place (the workspace has several tabs, or the
/// tab was named), otherwise its pane's name or title. Both are untrusted
/// daemon and terminal text. None when blank or a repeat of the agent's name.
export function agentCaption(agent: Agent, snapshot: Snapshot): string | null {
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === agent.workspace_id);
  const tab = tabs.find((t) => t.tab_id === agent.tab_id);
  const pane = snapshot.panes.find((p) => p.pane_id === agent.pane_id);
  const place = tab && (tabs.length > 1 || tab.custom_label) ? tab.label : pane?.label || agent.title;
  const caption = clean(place ?? "").trim();
  return caption && caption !== agentName(agent) ? caption : null;
}
