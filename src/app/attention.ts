// What needs you, read only from the daemon snapshot's agent statuses, never
// guessed from terminal output. Ordering and counting follow herdr-gpui.

import { clean } from "../changes/diff";
import type { Agent, AgentStatus, Snapshot, Tab } from "../protocol";

/// What the user marked seen, by pane: the `state_change_seq` each agent was at.
export type SeenPanes = Readonly<Record<string, number>>;

/// Attention first, then the most recent change (herdr-gpui's `status_priority`).
export const PRIORITY: Record<AgentStatus, number> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/// An agent's status once `seen` is applied. Herdr has no way to mark a pane
/// seen short of focusing it, so a `done` the user marked seen reads as the idle
/// Herdr would have turned it into, until its sequence moves. A blocked agent
/// still waits for you, whatever was marked.
export function effectiveStatus(agent: Agent, seen: SeenPanes): AgentStatus {
  return agent.agent_status === "done" && seen[agent.pane_id] === agent.state_change_seq ? "idle" : agent.agent_status;
}

/// `snapshot` as the user sees it, with `seen` applied to its agents and to the
/// statuses the daemon rolled up from them for tabs and workspaces. A copy, as
/// `withoutClosing` makes: the daemon's stays true for whatever acts on it, and
/// the same object comes back when nothing was marked.
export function seenSnapshot(snapshot: Snapshot, seen: SeenPanes): Snapshot {
  const hidden = snapshot.agents.filter((agent) => effectiveStatus(agent, seen) !== agent.agent_status);
  if (hidden.length === 0) return snapshot;
  const agents = snapshot.agents.map((agent) => ({ ...agent, agent_status: effectiveStatus(agent, seen) }));
  const rollUp = <T extends { agent_status: AgentStatus }>(item: T, own: (agent: Agent) => boolean): T => {
    const statuses = agents.filter(own).map((agent) => agent.agent_status);
    if (item.agent_status !== "done" || statuses.length === 0) return item;
    return { ...item, agent_status: statuses.reduce((a, b) => (PRIORITY[b] > PRIORITY[a] ? b : a)) };
  };
  return {
    ...snapshot,
    agents,
    tabs: snapshot.tabs.map((tab) => rollUp(tab, (agent) => agent.tab_id === tab.tab_id)),
    workspaces: snapshot.workspaces.map((workspace) => rollUp(workspace, (agent) => agent.workspace_id === workspace.workspace_id)),
  };
}

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
    list.sort((a, b) => PRIORITY[shownStatus(b)] - PRIORITY[shownStatus(a)]);
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
  const count = (status: AgentStatus) => agents.filter((agent) => shownStatus(agent) === status).length;
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

/// How a resting agent says its task ended, through dotfiles' `herdr-outcome`.
/// It outlives `done` turning idle once seen, and the next prompt clears it.
function restingOutcome(agent: Agent): string | null {
  const resting = agent.agent_status === "done" || agent.agent_status === "idle";
  return resting ? agentToken(agent, "attn_outcome") : null;
}

/// Whether an agent's task is finished for sure: it said so and Git agreed.
/// Herdr's own `done` only says a turn ended.
export function verifiedDone(agent: Agent): boolean {
  return restingOutcome(agent) === "verified";
}

const YOU = "you:";

/// What an agent that cannot move on until you act wants done: the text after
/// `herdr-outcome you`, null for any other agent. `left` and `unverified` ask
/// nothing of you. Herdr's `blocked` only covers a live prompt, so this session
/// reads done or idle, and being seen does not clear it: only the token going
/// does, at your next prompt to it or when it ends.
export function needsYouNote(agent: Agent): string | null {
  const outcome = restingOutcome(agent);
  return outcome?.startsWith(YOU) ? outcome.slice(YOU.length).trim() : null;
}

/// Whether an agent's outcome needs you.
export function outcomeNeedsYou(agent: Agent): boolean {
  return needsYouNote(agent) !== null;
}

/// The status an agent ranks and shows with: a finished one that needs you
/// goes with the blocked ones.
export function shownStatus(agent: Agent): AgentStatus {
  return outcomeNeedsYou(agent) ? "blocked" : agent.agent_status;
}

/// What a tab's agents need of you, or null when none does: one needing you is
/// enough to mark the tab.
export function tabNeedsYou(agents: readonly Agent[]): string | null {
  const notes = agents.map(needsYouNote).filter((note) => note !== null);
  return notes.length > 0 ? notes.filter(Boolean).join("; ") : null;
}

/// Whether a tab's agents are all finished for sure.
export function tabVerifiedDone(agents: readonly Agent[]): boolean {
  return agents.length > 0 && agents.every(verifiedDone);
}

/// Whether an agent wants you: it finished, is waiting for input, or finished
/// needing you. Done ones clear when the daemon or `seenSnapshot` marks them
/// seen, blocked ones when their status moves, the last when their outcome goes.
export function wantsYou(agent: Agent): boolean {
  const status = shownStatus(agent);
  return status === "blocked" || status === "done";
}

/// The agents Mark as Seen would clear. Not one that needs you, which it cannot.
export function unseenDone(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => shownStatus(agent) === "done");
}

/// The Dock badge.
export function attentionCount(snapshot: Snapshot | null): number {
  return snapshot?.agents.filter(wantsYou).length ?? 0;
}

/// The agents an expanded workspace card lists: all but the idle ones, which
/// want nothing and only pushed the rest down. The tally still counts them.
export function cardAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => shownStatus(agent) !== "idle");
}

/// How many agents a collapsed workspace card names before it says how many more.
const ATTENTION_ROWS = 3;

/// The agents a collapsed workspace card names, keeping their order, and how
/// many it leaves out: only the blocked ones. A finished agent is already
/// counted in the card's tally, and gets a row once the card is expanded.
export function attentionRows(agents: readonly Agent[]): { rows: Agent[]; more: number } {
  const blocked = agents.filter((agent) => shownStatus(agent) === "blocked");
  return { rows: blocked.slice(0, ATTENTION_ROWS), more: Math.max(0, blocked.length - ATTENTION_ROWS) };
}

