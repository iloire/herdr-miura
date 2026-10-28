// The sidebar's width: dragged by its edge, kept between launches in this
// window's storage, and always leaving the terminal most of the window.

export const SIDEBAR_DEFAULT = 232;
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 480;
/// The terminal keeps at least this share of the window.
const TERMINAL_SHARE = 0.5;
const KEY = "sidebar-width";

/// `width` held between the bounds and to at most half of `windowWidth`.
export function clampWidth(width: number, windowWidth: number): number {
  const max = Math.min(SIDEBAR_MAX, Math.floor(windowWidth * (1 - TERMINAL_SHARE)));
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(width, Math.max(SIDEBAR_MIN, max))));
}

/// The saved width, or the default when nothing usable is stored. Storage can
/// be missing or throw, and the sidebar must still draw.
export function loadWidth(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): number {
  try {
    const saved = Number(storage?.getItem(KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveWidth(width: number, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, String(width));
  } catch {
    // A width that is not remembered is only a convenience lost.
  }
}
