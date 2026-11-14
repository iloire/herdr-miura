// The sidebar's two views of the same agents: by workspace (its folders) or by
// status (the Agents tab). Which one shows, and whether the Agents tab's Done
// list is folded, are this window's, kept in its storage as the sort order is.

import type { Agent } from "../protocol";
import { loopTag, shownStatus } from "./attention";

const KEY = "sidebar-view";

export type SidebarView = "workspaces" | "agents";

export interface SidebarViewState {
  view: SidebarView;
  /// Finished agents fold to one line by default: they only want a look.
  doneFolded: boolean;
  recentFolded: boolean;
}

const DEFAULT: SidebarViewState = { view: "workspaces", doneFolded: true, recentFolded: false };

export function loadSidebarView(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): SidebarViewState {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      view: record.view === "agents" ? "agents" : "workspaces",
      doneFolded: typeof record.doneFolded === "boolean" ? record.doneFolded : DEFAULT.doneFolded,
      recentFolded: typeof record.recentFolded === "boolean" ? record.recentFolded : DEFAULT.recentFolded,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveSidebarView(state: SidebarViewState, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // A view that does not stick is only a convenience lost.
  }
}

/// An active agent with the workspace it belongs to, for its row.
export interface PlacedAgent {
  agent: Agent;
  workspaceId: string;
  label: string;
  hue: string;
}

export interface StatusSections {
  needsYou: PlacedAgent[];
  working: PlacedAgent[];
  done: PlacedAgent[];
  /// Sessions `/loop` will run again, whether ticking or between ticks: they
  /// stay active for good, so they keep out of Working and Done.
  loops: PlacedAgent[];
  /// Idle ones that worked lately, latest first: what was just marked seen.
  recent: PlacedAgent[];
}

/// Active agents by what they want of you: waiting on you, still working, or
/// finished unseen, with loops apart unless one waits on you. Each keeps the order it came in, the sidebar's. An agent
/// whose status Herdr cannot tell goes with the working ones: it is not idle.
/// Idle agents go to Recent while `idleSince` has them within the last
/// `RECENT_MS`, latest first and `RECENT_MAX` at most.
export function statusSections(
  agents: readonly PlacedAgent[],
  idleSince: IdleSince = {},
  now = Date.now(),
): StatusSections {
  const sections: StatusSections = { needsYou: [], working: [], done: [], loops: [], recent: [] };
  for (const placed of agents) {
    const status = shownStatus(placed.agent);
    if (status !== "blocked" && loopTag(placed.agent) !== null) sections.loops.push(placed);
    else if (status === "idle") {
      const since = idleSince[placed.agent.pane_id];
      if (since !== undefined && now - since < RECENT_MS) sections.recent.push(placed);
    } else if (status === "blocked") sections.needsYou.push(placed);
    else if (status === "done") sections.done.push(placed);
    else sections.working.push(placed);
  }
  const at = (placed: PlacedAgent) => idleSince[placed.agent.pane_id] ?? 0;
  sections.recent = sections.recent.sort((a, b) => at(b) - at(a)).slice(0, RECENT_MAX);
  return sections;
}

/// How long an agent stays in Recent once it goes idle, and how many it lists.
export const RECENT_MS = 12 * 60 * 60_000;
export const RECENT_MAX = 10;

const RECENT_KEY = "recent-agents";

/// When each agent last went idle, by pane, in epoch milliseconds. The
/// snapshot has no time for it, so the window notes it as it sees it happen.
export type IdleSince = Readonly<Record<string, number>>;

/// The `IdleSince` of each daemon boot, by boot id, kept in this window's
/// storage so a restart (Edge's, at every commit) does not empty Recent.
export type RecentRecords = Readonly<Record<string, IdleSince>>;

export function loadRecent(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): RecentRecords {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as RecentRecords) : {};
  } catch {
    return {};
  }
}

export function saveRecent(records: RecentRecords, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(records));
  } catch {
    // Recent only starts over at the next launch.
  }
}

/// `records` with the agents of boot `bootId` that were busy (`busy`, by pane)
/// and are idle now stamped `now`, without stamps older than `RECENT_MS` or of
/// panes this boot no longer has. The same object when nothing changes.
export function stampIdle(
  records: RecentRecords,
  bootId: string,
  busy: ReadonlySet<string>,
  agents: readonly Agent[],
  now: number,
): RecentRecords {
  const live = new Set(agents.map((agent) => agent.pane_id));
  let changed = false;
  const next: Record<string, IdleSince> = {};
  for (const [boot, panes] of Object.entries(records)) {
    const kept = Object.entries(panes).filter(([pane, at]) => now - at < RECENT_MS && (boot !== bootId || live.has(pane)));
    if (kept.length !== Object.keys(panes).length) changed = true;
    if (kept.length > 0) next[boot] = Object.fromEntries(kept);
  }
  for (const agent of agents) {
    if (busy.has(agent.pane_id) && shownStatus(agent) === "idle") {
      next[bootId] = { ...next[bootId], [agent.pane_id]: now };
      changed = true;
    }
  }
  return changed ? next : records;
}

/// The panes whose agents are not idle, for the next `stampIdle`.
export function busyPanes(agents: readonly Agent[]): Set<string> {
  return new Set(agents.filter((agent) => shownStatus(agent) !== "idle").map((agent) => agent.pane_id));
}
