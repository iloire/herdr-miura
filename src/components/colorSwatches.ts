import { HUE_SLOTS, type HueSlot, slotColor } from "../app/hue";
import type { MenuItem } from "./ContextMenu";

/// A menu's row of the palette's colors, each drawn by `paint`, after a hollow
/// one, called `none`, for no choice.
export function colorSwatches(
  label: string,
  none: string,
  chosen: HueSlot | null,
  pick: (slot: HueSlot | null) => void,
  paint: (slot: HueSlot) => string = slotColor,
): MenuItem {
  const named = (slot: HueSlot) => slot[0].toUpperCase() + slot.slice(1);
  return {
    label,
    swatches: [
      { label: none, color: null, current: chosen === null, onSelect: () => pick(null) },
      ...HUE_SLOTS.map((slot) => ({ label: named(slot), color: paint(slot), current: chosen === slot, onSelect: () => pick(slot) })),
    ],
  };
}
