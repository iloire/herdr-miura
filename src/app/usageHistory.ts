import { invoke } from "@tauri-apps/api/core";
import { type Minute, type Timeline, type Tokens, tokensSince, WEIGHTS, weighted } from "./sessionUsage";

// The week's token use of every project on this Mac, closed sessions included,
// for the usage dialog; the tab header's figures cover only sessions in a pane.

export interface ProjectUsage {
  name: string;
  /// Five-minute buckets, over the last eight days.
  minutes: Minute[];
}

/// The dialog's reread: a week of transcripts the first time, what was
/// appended since after that.
export function readUsageHistory(): Promise<ProjectUsage[]> {
  return invoke<ProjectUsage[]>("usage_history");
}

/// One calendar day's spend, weighted; `at` is its local midnight in Unix seconds.
export interface Day {
  at: number;
  spend: number;
}

/// The last `count` local calendar days, oldest first, today last. Built from
/// the calendar, not by subtracting 24 h, so a clock change cannot split a day.
export function dailySpend(history: readonly Timeline[], now: number, count = 7): Day[] {
  const today = new Date(now);
  const midnight = (back: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - back).getTime() / 1000;
  const days = Array.from({ length: count }, (_, i) => ({ at: midnight(count - 1 - i), spend: 0 }));
  const end = midnight(-1);
  for (const { minutes } of history) {
    for (const minute of minutes) {
      if (minute.at < days[0].at || minute.at >= end) continue;
      days[days.filter((day) => day.at <= minute.at).length - 1].spend += weighted(minute);
    }
  }
  return days;
}

export interface ProjectSpend {
  name: string;
  spend: number;
}

/// Projects by spend from `since` on, largest first, those past the first
/// `limit` folded into `Other`.
export function projectSpend(history: readonly ProjectUsage[], since: number, limit = 6): ProjectSpend[] {
  const ranked = history
    .map((project) => ({ name: project.name, spend: weighted(tokensSince([project], since)) }))
    .filter((project) => project.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  if (ranked.length <= limit) return ranked;
  const rest = ranked.slice(limit).reduce((sum, project) => sum + project.spend, 0);
  return [...ranked.slice(0, limit), { name: "Other", spend: rest }];
}

/// One kind of token's part of a spend.
export interface MixPart {
  kind: "output" | "cache-write" | "input" | "cache-read";
  label: string;
  tokens: number;
  /// What it costs next to fresh input, as printed.
  rate: string;
  spend: number;
  /// Of the whole spend, 0 to 1.
  share: number;
}

/// Tokens by kind in a fixed order, so a color always means the same kind.
/// The two cache writes differ only in how long they last, so they are one.
export function tokenMix(tokens: Tokens): MixPart[] {
  const total = weighted(tokens);
  const part = (kind: MixPart["kind"], label: string, count: number, rate: string, spend: number): MixPart => ({
    kind,
    label,
    tokens: count,
    rate,
    spend,
    share: total > 0 ? spend / total : 0,
  });
  const written = tokens.cache_write_5m + tokens.cache_write_1h;
  return [
    part("output", "Output", tokens.output, `×${WEIGHTS.output}`, tokens.output * WEIGHTS.output),
    part(
      "cache-write",
      "Cache write",
      written,
      `×${WEIGHTS.cache_write_5m}–${WEIGHTS.cache_write_1h}`,
      tokens.cache_write_5m * WEIGHTS.cache_write_5m + tokens.cache_write_1h * WEIGHTS.cache_write_1h,
    ),
    part("input", "Input", tokens.input, `×${WEIGHTS.input}`, tokens.input * WEIGHTS.input),
    part("cache-read", "Cache read", tokens.cache_read, `×${WEIGHTS.cache_read}`, tokens.cache_read * WEIGHTS.cache_read),
  ];
}
