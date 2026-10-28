import type { PaneInputEvent } from "../protocol";

/// Bound on one paste, matching herdr-gpui's clipboard bound.
export const MAX_PASTE_BYTES = 2 * 1024 * 1024;

export const MAX_WHEEL_LINES = 40;

/// Wheel input for `lines` (positive scrolls up). Scrollback takes one event
/// carrying the whole count; an application reading the wheel gets one event
/// per line, since Herdr turns each event into exactly one report for it.
export function wheelEvents(
  lines: number,
  column: number,
  row: number,
  modifiers: number,
  stepwise: boolean,
): PaneInputEvent[] {
  if (lines === 0) return [];
  const kind = lines > 0 ? "ScrollUp" : "ScrollDown";
  // A hard flick must not flood the bounded command queue.
  const count = Math.min(Math.abs(lines), MAX_WHEEL_LINES);
  const event = (each: number): PaneInputEvent => ({
    Mouse: {
      kind,
      position: { Cell: { column: Math.max(0, column), row: Math.max(0, row) } },
      geometry: null,
      modifiers,
      lines: each,
    },
  });
  return stepwise ? Array.from({ length: count }, () => event(1)) : [event(count)];
}

/// A paste, refused past the bound rather than truncated mid-character.
export function pasteEvents(text: string): PaneInputEvent[] {
  if (new TextEncoder().encode(text).length > MAX_PASTE_BYTES) return [];
  return [{ Paste: text }];
}
