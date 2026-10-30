// The widths of the panes at the window's edges, the sidebar and the drawer:
// dragged by their inner edge, kept between launches in this window's storage,
// and always leaving the terminal most of the room.

export type Pane = {
  name: string;
  /// The window edge it sits on, which decides the way a drag grows it.
  side: "left" | "right";
  default: number;
  min: number;
  max: number;
  key: string;
};

export const SIDEBAR: Pane = { name: "sidebar", side: "left", default: 232, min: 160, max: 480, key: "sidebar-width" };
export const DRAWER: Pane = { name: "drawer", side: "right", default: 320, min: 260, max: 640, key: "drawer-width" };

/// The terminal keeps at least this share of what is left to it and a pane.
const TERMINAL_SHARE = 0.5;

function bounded(pane: Pane, width: number): number {
  return Math.max(pane.min, Math.min(width, pane.max));
}

/// `width` held between the sidebar's bounds and to at most half of `windowWidth`.
export function clampSidebar(width: number, windowWidth: number): number {
  const room = Math.floor(windowWidth * (1 - TERMINAL_SHARE));
  return Math.round(Math.max(SIDEBAR.min, Math.min(bounded(SIDEBAR, width), room)));
}

/// `width` held between the drawer's bounds and to at most half of what the
/// sidebar leaves (`sidebarWidth`, 0 when hidden). That room wins over the
/// minimum: the window can be narrower than both panes' minimums together.
export function clampDrawer(width: number, windowWidth: number, sidebarWidth: number): number {
  const room = Math.floor((windowWidth - sidebarWidth) * (1 - TERMINAL_SHARE));
  return Math.round(Math.min(bounded(DRAWER, width), room));
}

/// The saved width, or the default when nothing usable is stored. Storage can
/// be missing or throw, and the pane must still draw.
export function loadWidth(pane: Pane, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): number {
  try {
    const saved = Number(storage?.getItem(pane.key));
    return Number.isFinite(saved) && saved > 0 ? saved : pane.default;
  } catch {
    return pane.default;
  }
}

export function saveWidth(
  pane: Pane,
  width: number,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(pane.key, String(width));
  } catch {
    // A width that is not remembered is only a convenience lost.
  }
}
