// The color that tells a workspace apart, ported from herdr-gpui's
// `folders::model::hue`, so a name lands on the same slot in both apps.

import { css } from "../terminal/theme";
import { activeTheme } from "../themes/active";
import { legible } from "../themes/chrome";
import type { Workspace } from "../protocol";
import type { Row } from "./worktreeGroups";

/// The palette slots by name, in order: a slot's number is its index plus one.
export const HUE_SLOTS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
export type HueSlot = (typeof HUE_SLOTS)[number];

export const isHueSlot = (value: unknown): value is HueSlot => HUE_SLOTS.includes(value as HueSlot);

/// The palette slot, red (1) to cyan (6), for `name`: the same on every launch.
export function hue(name: string): number {
  // FNV-1a over the UTF-8 bytes, then Murmur3's finalizer, whose mixing keeps
  // names from crowding onto two slots. `Math.imul` and `>>> 0` keep it u32.
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return 1 + ((hash >>> 0) % 6);
}

/// Palette slot `slot` as a CSS color, from the active theme's palette, moved
/// as far as it takes to read: the chrome writes names in it.
function slotCss(slot: number): string {
  const { terminal, chrome } = activeTheme();
  return css(legible(terminal.palette[slot], chrome.tokens));
}

/// `name`'s hue as a CSS color.
export function hueColor(name: string): string {
  return slotCss(hue(name));
}

/// A chosen slot as a CSS color.
export function slotColor(slot: HueSlot): string {
  return slotCss(HUE_SLOTS.indexOf(slot) + 1);
}

/// Every workspace with a chosen color, by workspace id: its own folder's, or
/// for a worktree its main checkout's, which alone can choose one.
export function workspaceSlots(
  rows: readonly Row[],
  rootOf: (workspace: Workspace) => string | null,
  colors: Readonly<Record<string, HueSlot>>,
): Map<string, HueSlot> {
  const slots = new Map<string, HueSlot>();
  for (const { workspace, parent } of rows) {
    const root = rootOf(parent ?? workspace);
    const slot = root === null ? undefined : colors[root];
    if (slot) slots.set(workspace.workspace_id, slot);
  }
  return slots;
}

/// The one way a workspace's color is worked out: its chosen slot, else the
/// automatic hue of its name.
export function workspaceHue(workspace: Pick<Workspace, "workspace_id" | "label">, slots: ReadonlyMap<string, HueSlot>): string {
  const slot = slots.get(workspace.workspace_id);
  return slot ? slotColor(slot) : hueColor(workspace.label);
}
