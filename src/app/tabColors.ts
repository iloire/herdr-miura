// Tab colors, chosen in a tab's menu. Herdr has no such thing and a tab has no
// lasting identity of its own, so the window keeps them as it keeps pins: by
// daemon boot and tab id, as a restarted daemon may hand an old tab id to a new
// tab. The slot's name is stored, not a color, so a tab follows the theme.

import { type HueSlot, isHueSlot } from "./hue";
import { pinKey } from "./pins";

const KEY = "tab-colors";

export function loadTabColors(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Map<string, HueSlot> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return new Map();
    return new Map(Object.entries(saved).filter((entry): entry is [string, HueSlot] => isHueSlot(entry[1])));
  } catch {
    return new Map();
  }
}

/// Saves `colors`, keeping only those of the running daemon so the list never grows.
export function saveTabColors(
  colors: ReadonlyMap<string, HueSlot>,
  bootId: string,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    const running = [...colors].filter(([key]) => key.startsWith(`${bootId}/`));
    storage?.setItem(KEY, JSON.stringify(Object.fromEntries(running)));
  } catch {
    // Colors that are not remembered are only a convenience lost.
  }
}

/// `colors` without the closed tabs of the running daemon, or `colors` itself
/// when there are none. `tabIds` are the tabs the daemon lists.
export function withoutClosedTabs(
  colors: ReadonlyMap<string, HueSlot>,
  bootId: string,
  tabIds: readonly string[],
): ReadonlyMap<string, HueSlot> {
  const open = new Set(tabIds.map((tabId) => pinKey(bootId, tabId)));
  const kept = [...colors].filter(([key]) => !key.startsWith(`${bootId}/`) || open.has(key));
  return kept.length === colors.size ? colors : new Map(kept);
}
