// The sidebar's two views of the same agents: by workspace (its folders) or by
// status (the Agents tab). Which one shows, and whether the Agents tab's Done
// list is folded, are this window's, kept in its storage as the sort order is.

import type { Agent } from "../protocol";
import { shownStatus } from "./attention";

const KEY = "sidebar-view";

export type SidebarView = "workspaces" | "agents";

export interface SidebarViewState {
  view: SidebarView;
  /// Finished agents fold to one line by default: they only want a look.
  doneFolded: boolean;
}

const DEFAULT: SidebarViewState = { view: "workspaces", doneFolded: true };

export function loadSidebarView(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): SidebarViewState {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      view: record.view === "agents" ? "agents" : "workspaces",
      doneFolded: typeof record.doneFolded === "boolean" ? record.doneFolded : DEFAULT.doneFolded,
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
}

/// Active agents by what they want of you: waiting on you, still working, or
/// finished unseen. Each keeps the order it came in, the sidebar's. An agent
/// whose status Herdr cannot tell goes with the working ones: it is not idle.
export function statusSections(agents: readonly PlacedAgent[]): StatusSections {
  const sections: StatusSections = { needsYou: [], working: [], done: [] };
  for (const placed of agents) {
    const status = shownStatus(placed.agent);
    if (status === "idle") continue;
    if (status === "blocked") sections.needsYou.push(placed);
    else if (status === "done") sections.done.push(placed);
    else sections.working.push(placed);
  }
  return sections;
}
