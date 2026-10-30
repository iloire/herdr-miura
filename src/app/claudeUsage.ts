import { invoke } from "@tauri-apps/api/core";
import { formatMinutes, formatMoment } from "./time";

/// One limit window as `claude_usage` reports it. `resets_at` is Anthropic's
/// own: an ISO time, or epoch seconds.
export interface UsageWindow {
  percent: number;
  resets_at: string | number | null;
}

/// A weekly limit of its own on one model, such as Fable.
export interface ModelWindow extends UsageWindow {
  name: string;
}

/// One surface's part of this week's use, such as Claude Code or Chats.
export interface Share {
  name: string;
  percent: number;
}

/// Paid use past the plan's limits, this month.
export interface ExtraUsage {
  enabled: boolean;
  /// `12.34 EUR`.
  used: string | null;
  limit: string | null;
}

export interface ClaudeUsage {
  /// `Max 20x`, `Pro`.
  plan: string | null;
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  models: ModelWindow[];
  surfaces: Share[];
  extra: ExtraUsage | null;
  /// When Anthropic answered, in Unix seconds.
  read_at: number;
}

export const SESSION_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;
/// Less of a window than this has passed: too early for its pace to mean much.
const PACE_FLOOR = 0.1;

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

/// How the status bar and the dialog color a window: amber from 75 %, red from 90 %.
export function usageLevel(used: number): "" | "warm" | "high" {
  return used >= 90 ? "high" : used >= 75 ? "warm" : "";
}

/// The share of a window of `span` ms that has passed, 0 to 1; `null` once
/// the reset has passed or is unknown.
export function elapsed(window: UsageWindow, span: number, now: number): number | null {
  const at = resetTime(window);
  if (at === null || at <= now) return null;
  return Math.max(0, 1 - (at - now) / span);
}

/// Where the window is heading if use carries on at its rate so far.
export function paceNote(window: UsageWindow, span: number, now: number): string | null {
  if (window.percent >= 100) return "Limit reached";
  const passed = elapsed(window, span, now);
  if (passed === null || passed < PACE_FLOOR) return null;
  const landing = window.percent / passed;
  if (landing < 100) return `On pace for ${Math.round(landing)}% by the reset`;
  const start = (resetTime(window) as number) - span;
  return `On pace to hit the limit around ${formatMoment(start + ((now - start) * 100) / window.percent)}`;
}
