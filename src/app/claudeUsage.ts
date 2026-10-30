import { invoke } from "@tauri-apps/api/core";
import { formatMinutes } from "./time";

/// One limit window as `claude_usage` reports it. `resets_at` is Anthropic's
/// own: an ISO time, or epoch seconds.
export interface UsageWindow {
  percent: number;
  resets_at: string | number | null;
}

export interface ClaudeUsage {
  /// `Max 20x`, `Pro`.
  plan: string | null;
  session: UsageWindow | null;
  weekly: UsageWindow | null;
}

/// This Mac's Claude plan usage, or `null` when Claude Code is signed out.
/// The backend keeps a reading for ten minutes, so polling it is cheap.
export function readClaudeUsage(): Promise<ClaudeUsage | null> {
  return invoke<ClaudeUsage | null>("claude_usage");
}

/// When the window resets, in epoch milliseconds.
export function resetTime(window: UsageWindow): number | null {
  const { resets_at } = window;
  if (resets_at === null) return null;
  const ms = typeof resets_at === "number" ? resets_at * 1000 : Date.parse(resets_at);
  return Number.isFinite(ms) ? ms : null;
}

/// `4h 30m`, `4d 11h`, `12m`, as herdr-gpui's status bar counts down; `null`
/// once the reset has passed or is unknown.
export function resetsIn(window: UsageWindow, now: number): string | null {
  const at = resetTime(window);
  if (at === null || at <= now) return null;
  return formatMinutes(Math.ceil((at - now) / 60_000));
}

/// Whole percent, clamped to the bar.
export function percent(window: UsageWindow): number {
  return Math.min(100, Math.max(0, Math.round(window.percent)));
}
