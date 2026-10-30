// What needs you, read only from the daemon snapshot's agent statuses, never
// guessed from terminal output. Ordering and counting follow herdr-gpui.

import { clean } from "../changes/diff";
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

/// What a workspace card calls an agent: its tab, as the tab strip
/// has it, since `agent` reads "claude" on nearly every row. Agents sharing a
/// tab add their own name, so their rows differ.
export function agentRowName(agent: Agent, tabs: readonly Tab[], counts: ReadonlyMap<string, number>): string {
  const own = agent.name ?? agent.display_agent ?? agent.agent ?? "agent";
  const tab = tabs.find((candidate) => candidate.tab_id === agent.tab_id);
  if (!tab) return own;
  return (counts.get(agent.tab_id) ?? 0) > 1 ? `${tab.label} · ${own}` : tab.label;
}

/// What an agent says it is working on, for the strip over the terminal: a
/// reported title, else the terminal's. Null when blank or when it only repeats
/// the agent, as Claude Code's "Claude Code" does until a session has a topic.
export function agentTitle(agent: Agent): string | null {
  const title = clean(agent.title?.trim() || agent.terminal_title_stripped || "").trim();
  const own = [agent.name, agent.display_agent, agent.agent, "claude code"];
  return title && !own.some((name) => name?.toLowerCase() === title.toLowerCase()) ? title : null;
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

/// Whether an agent's task is finished for sure: it said so through dotfiles'
/// `herdr-outcome` and Git agreed. Herdr's own `done` only says a turn ended.
/// It outlives `done` turning idle once seen, and the next prompt clears it.
export function verifiedDone(agent: Agent): boolean {
  const resting = agent.agent_status === "done" || agent.agent_status === "idle";
  return resting && agentToken(agent, "attn_outcome") === "verified";
}

/// Whether a tab's agents are all finished for sure.
export function tabVerifiedDone(agents: readonly Agent[]): boolean {
  return agents.length > 0 && agents.every(verifiedDone);
}

/// Whether an agent wants you: it finished or is waiting for input. Done ones
/// clear when the daemon marks them seen, blocked ones when their status moves.
export function wantsYou(agent: Agent): boolean {
  return agent.agent_status === "blocked" || agent.agent_status === "done";
}

/// The Dock badge.
export function attentionCount(snapshot: Snapshot | null): number {
  return snapshot?.agents.filter(wantsYou).length ?? 0;
}

/// The agents an expanded workspace card lists: all but the idle ones, which
/// want nothing and only pushed the rest down. The tally still counts them.
export function cardAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.agent_status !== "idle");
}

/// How many agents a collapsed workspace card names before it says how many more.
const ATTENTION_ROWS = 3;

/// The agents a collapsed workspace card names, keeping their order, and how
/// many it leaves out: only the blocked ones. A finished agent is already
/// counted in the card's tally, and gets a row once the card is expanded.
export function attentionRows(agents: readonly Agent[]): { rows: Agent[]; more: number } {
  const blocked = agents.filter((agent) => agent.agent_status === "blocked");
  return { rows: blocked.slice(0, ATTENTION_ROWS), more: Math.max(0, blocked.length - ATTENTION_ROWS) };
}

