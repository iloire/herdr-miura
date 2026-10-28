// The color that tells a workspace apart, ported from herdr-gpui's
// `folders::model::hue`, so a name lands on the same slot in both apps.

import { DEFAULT_THEME } from "../terminal/theme";

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

/// `name`'s hue as a CSS color.
export function hueColor(name: string): string {
  return `#${DEFAULT_THEME.palette[hue(name)].toString(16).padStart(6, "0")}`;
}
