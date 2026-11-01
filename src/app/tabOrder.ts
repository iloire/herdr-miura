// How the tab strip orders a workspace's tabs: working tabs first, or what needs
// you first. Either way the order is the strip's alone: a tab goes back to its
// place in the daemon's list once its status drops, and ⌘1–9 keep counting that
// list, so a shortcut doesn't change target with an agent's status. The choice
// is this window's, kept in its storage.

import type { Agent, Tab } from "../protocol";
import { outcomeNeedsYou, PRIORITY } from "./attention";

export type TabSort = "working" | "attention";

const KEY = "tab-sort";

export function loadTabSort(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): TabSort {
  try {
    return storage?.getItem(KEY) === "attention" ? "attention" : "working";
  } catch {
    return "working";
  }
}

export function saveTabSort(sort: TabSort, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, sort);
  } catch {
    // A sort that is not remembered is only a convenience lost.
  }
}

/// How far ahead each tab goes, higher first. Tabs at rest are left out, so they
/// keep their place and a new one moves nothing. By attention: blocked, done,
/// working. A finished agent that needs you ranks its tab with the blocked ones,
/// which the daemon's status for it cannot say.
export function tabRanks(tabs: readonly Tab[], sort: TabSort, agents: readonly Agent[]): Map<string, number> {
  const waiting = new Set(agents.filter(outcomeNeedsYou).map((agent) => agent.tab_id));
  const rank = (tab: Tab) => {
    if (sort === "working") return tab.agent_status === "working" ? 1 : 0;
    return PRIORITY[waiting.has(tab.tab_id) ? "blocked" : tab.agent_status] - PRIORITY.idle;
  };
  return new Map(tabs.filter((tab) => rank(tab) > 0).map((tab) => [tab.tab_id, rank(tab)]));
}

/// `tabs` as the strip shows them: pinned first, then by `ranks`, each group in
/// the daemon's order. The caller decides the ranks, so `useSteadyStrip` can hold
/// the tabs still under the pointer.
export function stripOrder(
  tabs: readonly Tab[],
  isPinned: (tab: Tab) => boolean,
  ranks: ReadonlyMap<string, number>,
): Tab[] {
  const rank = (tab: Tab) => ranks.get(tab.tab_id) ?? 0;
  const rest = tabs.filter((tab) => !isPinned(tab)).sort((a, b) => rank(b) - rank(a));
  return [...tabs.filter(isPinned), ...rest];
}
