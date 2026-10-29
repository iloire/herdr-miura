// What needs you, read only from the daemon snapshot's agent statuses, never
// guessed from terminal output. Ordering and counting follow herdr-gpui.

import type { Agent, AgentStatus, Snapshot } from "../protocol";

/// Attention first, then the most recent change (herdr-gpui's `status_priority`).
export const PRIORITY: Record<AgentStatus, number> = {
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

/// How many agents run in each tab, for the count a tab with several shows.
export function agentCountsByTab(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of snapshot.agents) counts.set(agent.tab_id, (counts.get(agent.tab_id) ?? 0) + 1);
  return counts;
}

/// A workspace card's marks: one per live status among its agents, so a
/// finished agent cannot hide one still working or one waiting on you. Idle
/// shows only when nothing else does, and a workspace without agents falls
/// back to the daemon's own status for it.
export function workspaceMarks(
  agents: readonly Agent[],
  fallback: AgentStatus,
): { status: AgentStatus; count: number }[] {
  if (agents.length === 0) return [{ status: fallback, count: 0 }];
  const count = (status: AgentStatus) => agents.filter((agent) => agent.agent_status === status).length;
  const live = (["blocked", "working", "done"] as const)
    .map((status) => ({ status, count: count(status) }))
    .filter((mark) => mark.count > 0);
  if (live.length > 0) return live;
  return count("idle") > 0 ? [{ status: "idle", count: count("idle") }] : [];
}

/// The Dock badge: agents that finished or are waiting for input. Done ones
/// clear when the daemon marks them seen, blocked ones when their status moves.
export function attentionCount(snapshot: Snapshot | null): number {
  return snapshot?.agents.filter((a) => a.agent_status === "blocked" || a.agent_status === "done").length ?? 0;
}

