// The sidebar's Agents section: how tall it is and whether it is folded. Both
// are this window's, kept in its storage as the sort order is. A null height
// lets the section size to its rows, up to its share of the sidebar.

const KEY = "sidebar-agents-panel";

/// The shortest the section can be dragged: its head and about one row.
export const AGENTS_MIN_HEIGHT = 64;
/// What the dragged section leaves above it for the workspaces.
export const WORKSPACES_MIN_HEIGHT = 96;

export interface AgentsPanel {
  height: number | null;
  folded: boolean;
}

export function loadAgentsPanel(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): AgentsPanel {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const height = typeof record.height === "number" && Number.isFinite(record.height) && record.height > 0 ? Math.round(record.height) : null;
    return { height, folded: record.folded === true };
  } catch {
    return { height: null, folded: false };
  }
}

export function saveAgentsPanel(panel: AgentsPanel, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(panel));
  } catch {
    // A height that does not stick is only a convenience lost.
  }
}

/// `height` held to what fits in a sidebar column `room` pixels tall, so the
/// workspaces above always keep some space.
export function clampAgentsHeight(height: number, room: number): number {
  const max = Math.max(AGENTS_MIN_HEIGHT, room - WORKSPACES_MIN_HEIGHT);
  return Math.round(Math.min(max, Math.max(AGENTS_MIN_HEIGHT, height)));
}
