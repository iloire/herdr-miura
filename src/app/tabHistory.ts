/// The tabs focused before and after the current one, across every workspace,
/// as a browser keeps its pages: Back returns to the tab you left, wherever it is.
export interface TabHistory {
  back: readonly string[];
  forward: readonly string[];
  current: string | null;
}

export type Direction = "back" | "forward";

export const EMPTY_HISTORY: TabHistory = { back: [], forward: [], current: null };

/// Enough to find your way back through a working session, never a growing list.
const LIMIT = 50;

/// The tab a step in `direction` goes to: the nearest one still open that isn't
/// the current one, or null when there is none.
export function stepTarget(history: TabHistory, direction: Direction, open: ReadonlySet<string>): string | null {
  const list = direction === "back" ? history.back : history.forward;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] !== history.current && open.has(list[i])) return list[i];
  }
  return null;
}

/// The history once `tabId` has the focus. A focus that a step in `via` asked for
/// moves along the history; any other is a new visit, which drops what lay ahead.
export function visit(history: TabHistory, tabId: string | null, via: { direction: Direction; target: string } | null): TabHistory {
  if (tabId === null || tabId === history.current) return history;
  if (history.current === null) return { ...history, current: tabId };
  if (via && via.target === tabId) {
    const from = via.direction === "back" ? history.back : history.forward;
    const to = via.direction === "back" ? history.forward : history.back;
    const at = from.lastIndexOf(tabId);
    if (at >= 0) {
      // Tabs skipped over were closed, so they don't move to the other side.
      const moved = { from: from.slice(0, at), to: [...to, history.current].slice(-LIMIT) };
      return via.direction === "back"
        ? { back: moved.from, forward: moved.to, current: tabId }
        : { back: moved.to, forward: moved.from, current: tabId };
    }
  }
  return { back: [...history.back, history.current].slice(-LIMIT), forward: [], current: tabId };
}
