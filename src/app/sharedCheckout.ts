// More than one agent working in one checkout, which is how parallel agents
// overwrite each other, for the tab header. The snapshot says where each pane
// is but not which checkout that is: only Git knows the top level, so the
// focused pane's comes from the Changes store and the linked worktrees from
// `worktrees.rs`. Together they settle every other pane without asking Git for
// each one.

import type { ChangesState } from "../changes/store";
import type { AgentStatus, Pane, Snapshot } from "../protocol";
import { agentCountsByTab, agentRowName } from "./attention";
import { inside } from "./worktreeGroups";

/// Who can still write here. Working is writing now. Blocked counts too: it is
/// waiting on you mid-task, with its edits half made, and carries on once
/// answered. Done and idle have ended their turn, so one parked in the folder
/// changes nothing, and unknown is no reason to warn.
const WRITING: readonly AgentStatus[] = ["working", "blocked"];

/// Where agents and the queue make their worktrees. The list of linked
/// worktrees is read every 10 s and stops at 16, so a queued prompt's new
/// worktree would otherwise count as its parent checkout until the next read.
const NESTED_WORKTREES = "/.claude/worktrees/";

export interface SharedCheckout {
  /// Agents that can write in the focused pane's checkout, at least two.
  count: number;
  /// What the sidebar calls them, the focused pane's own agent left out.
  others: string[];
}

/// The folder a pane is working in: its foreground process's, else its shell's.
export function paneDirectory(pane: Pane | undefined): string | null {
  return pane?.foreground_cwd ?? pane?.cwd ?? null;
}

/// `directory` is in `checkout` itself, not in a linked worktree inside it.
function inCheckout(directory: string, checkout: string, linked: readonly string[]): boolean {
  if (!inside(directory, checkout)) return false;
  if (directory.slice(checkout.replace(/\/+$/, "").length).startsWith(NESTED_WORKTREES)) return false;
  return !linked.some((worktree) => worktree !== checkout && inside(directory, worktree));
}

/// Whether the focused pane's checkout is shared, null when it is not. Like
/// `tabGit`, a read of any other directory counts as nothing, and a folder
/// outside Git has no checkout to share.
export function sharedCheckout(
  snapshot: Snapshot,
  state: ChangesState,
  directory: string | null,
  linked: readonly string[],
): SharedCheckout | null {
  if (state.phase !== "ready" || state.directory !== directory || !state.checkout) return null;
  const checkout = state.checkout.path;
  const agents = snapshot.agents.filter((agent) => {
    if (!WRITING.includes(agent.agent_status)) return false;
    const folder = paneDirectory(snapshot.panes.find((pane) => pane.pane_id === agent.pane_id));
    return folder !== null && inCheckout(folder, checkout, linked);
  });
  if (agents.length < 2) return null;
  const counts = agentCountsByTab(snapshot);
  const others = agents.filter((agent) => agent.pane_id !== snapshot.focused_pane_id);
  return { count: agents.length, others: others.map((agent) => agentRowName(agent, snapshot.tabs, counts)) };
}

/// The warning's tooltip.
export function sharedTitle(shared: SharedCheckout): string {
  return [`${shared.count} agents can write in this checkout and may overwrite each other`, ...shared.others.map((name) => `Also here: ${name}`)].join("\n");
}
