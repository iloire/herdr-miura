// Pinned tabs. Herdr has no pinning, so the window keeps it: a pinned tab
// shows a pin, loses its close button, and sits before the others. Pins are
// keyed by the daemon's boot as well as the tab, since a restarted daemon may
// hand an old tab id to a new tab.

import type { Tab } from "../protocol";

const KEY = "pinned-tabs";

export function pinKey(bootId: string, tabId: string): string {
  return `${bootId}/${tabId}`;
}

export function loadPins(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Set<string> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/// Saves `pins`, keeping only those of the running daemon so the list never grows.
export function savePins(
  pins: Set<string>,
  bootId: string,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...pins].filter((key) => key.startsWith(`${bootId}/`))));
  } catch {
    // Pins that are not remembered are only a convenience lost.
  }
}

/// The pinned tabs of each workspace, by workspace id, in the daemon's order.
export function pinnedByWorkspace(tabs: readonly Tab[], isPinned: (tab: Tab) => boolean): Map<string, Tab[]> {
  const byWorkspace = new Map<string, Tab[]>();
  for (const tab of tabs.filter(isPinned)) {
    byWorkspace.set(tab.workspace_id, [...(byWorkspace.get(tab.workspace_id) ?? []), tab]);
  }
  return byWorkspace;
}

/// `tabs` with the pinned ones first, each group in the daemon's order.
export function pinnedFirst(tabs: readonly Tab[], isPinned: (tab: Tab) => boolean): Tab[] {
  return [...tabs.filter(isPinned), ...tabs.filter((tab) => !isPinned(tab))];
}

/// Where `tab` belongs in its workspace once pinned or unpinned: right after
/// the other pinned tabs. Sent as `tab.move`'s `insert_index`, so the daemon's
/// order, and the shortcuts that focus tab N, match what the strip shows.
export function pinIndex(tabs: readonly Tab[], tab: Tab, isPinned: (tab: Tab) => boolean): number {
  return tabs.filter((other) => other.workspace_id === tab.workspace_id && other.tab_id !== tab.tab_id && isPinned(other))
    .length;
}
