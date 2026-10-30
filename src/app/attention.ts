// What needs you, read only from the daemon snapshot's agent statuses, never
// guessed from terminal output. Ordering and counting follow herdr-gpui.

import type { Agent, AgentStatus, Snapshot, Tab } from "../protocol";

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

/// What the sidebar's Agents section calls an agent: its tab, as the tab strip
/// has it, since `agent` reads "claude" on nearly every row. Agents sharing a
/// tab add their own name, so their rows differ.
export function agentRowName(agent: Agent, tabs: readonly Tab[], counts: ReadonlyMap<string, number>): string {
  const own = agent.name ?? agent.display_agent ?? agent.agent ?? "agent";
  const tab = tabs.find((candidate) => candidate.tab_id === agent.tab_id);
  if (!tab) return own;
  return (counts.get(agent.tab_id) ?? 0) > 1 ? `${tab.label} · ${own}` : tab.label;
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

/// The loop tag a Claude session carries while `/loop` will run it again, as
/// dotfiles' `herdr-attention` reports it from Claude Code's hooks (e.g.
/// "↻ loop 14:32", the next wakeup). Herdr has no idea of a loop: between
/// ticks it reports the session done or idle.
export function loopTag(agent: Agent): string | null {
  return agentToken(agent, "attn_loop");
}

/// A metadata token reported on the agent's pane, by name, with or without
/// the `$` Herdr's config writes before it.
export function agentToken(agent: Agent, name: string): string | null {
  return agent.tokens.find(([key]) => key.replace(/^\$/, "") === name)?.[1] ?? null;
}

/// The loop tags among some agents: a tab's or a workspace's.
export function loopTags(agents: readonly Agent[]): string[] {
  return agents.map(loopTag).filter((tag) => tag !== null);
}

/// The Dock badge: agents that finished or are waiting for input. Done ones
/// clear when the daemon marks them seen, blocked ones when their status moves.
export function attentionCount(snapshot: Snapshot | null): number {
  return snapshot?.agents.filter((a) => a.agent_status === "blocked" || a.agent_status === "done").length ?? 0;
}

