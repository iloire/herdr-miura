import { invoke } from "@tauri-apps/api/core";
import type { Agent } from "../protocol";
import type { StatusSince } from "./agentAge";
import { agentToken } from "./attention";
import { type ClaudeUsage, resetTime } from "./claudeUsage";
import { formatMinutes } from "./time";

// Token use of each Claude Code session, read from its transcript by
// `session_usage`. The session's id is the `claude_session` token dotfiles'
// `herdr-attention` reports on its pane from Claude Code's hooks.

/// Tokens by kind, as the API's `usage` reports them.
export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
}

/// One minute's tokens; `at` is its start in Unix seconds.
export interface Minute extends Tokens {
  at: number;
}

export interface SessionUsage {
  /// The model of its last response, e.g. `claude-opus-5-5`.
  model: string | null;
  /// The last response's prompt: the context the next turn starts from.
  context: number;
  /// Subagents included, by minute over the last six hours.
  minutes: Minute[];
  /// When its transcript or a subagent's last changed, in Unix seconds.
  written_at: number | null;
  /// Its latest prompt, the start of it when long.
  prompt: string | null;
  /// The folders it has worked in, latest first, each once.
  cwds: string[];
}

/// Anything that keeps its tokens over time.
export type Timeline = Pick<SessionUsage, "minutes">;

/// What each kind of token costs next to a fresh input token, as Anthropic
/// prices them: raw counts would rank a session by the cache reads every turn
/// repeats, which cost a tenth of fresh input.
export const WEIGHTS: Tokens = { input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 };

const KINDS = Object.keys(WEIGHTS) as (keyof Tokens)[];
const PLAN_WINDOW_S = 5 * 3600;

/// The agent's Claude Code session id, or `null` before its first hook has run.
export function sessionOf(agent: Agent): string | null {
  return agentToken(agent, "claude_session");
}

/// Each session's use, by id; `null` for one whose transcript could not be read.
export async function readSessionUsage(sessions: string[]): Promise<Map<string, SessionUsage | null>> {
  const usages = await invoke<(SessionUsage | null)[]>("session_usage", { sessions });
  return new Map(sessions.map((id, i) => [id, usages[i] ?? null]));
}

/// Tokens weighted as fresh input tokens.
export function weighted(tokens: Tokens): number {
  return KINDS.reduce((sum, kind) => sum + tokens[kind] * WEIGHTS[kind], 0);
}

/// The tokens of some sessions from `since` (Unix seconds) on.
export function tokensSince(usages: readonly Timeline[], since: number): Tokens {
  const total: Tokens = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
  for (const usage of usages) {
    for (const minute of usage.minutes) {
      if (minute.at < since) continue;
      for (const kind of KINDS) total[kind] += minute[kind];
    }
  }
  return total;
}

/// Where the plan's 5-hour window began, in Unix seconds: its reset less five
/// hours, so the header counts what the status bar's meter counts, else the
/// last five hours.
export function windowStart(plan: ClaudeUsage | null, now: number): number {
  const reset = plan?.session ? resetTime(plan.session) : null;
  const end = reset !== null && reset > now ? reset : now;
  return Math.floor(end / 1000) - PLAN_WINDOW_S;
}

/// Weighted spend of some sessions in `count` buckets of `minutes` each,
/// oldest first, ending at `now` (Unix seconds): the header's burn chart.
export function burn(usages: readonly Timeline[], now: number, count = 5, minutes = 3): number[] {
  const bars = new Array<number>(count).fill(0);
  const span = minutes * 60;
  const start = now - count * span;
  for (const usage of usages) {
    for (const minute of usage.minutes) {
      if (minute.at < start || minute.at >= now) continue;
      bars[Math.floor((minute.at - start) / span)] += weighted(minute);
    }
  }
  return bars;
}

/// Context sizes the header marks: every turn pays about its context, and a
/// long one also recalls less well, so past `high` it is worth noticing and
/// past `over` worth a `/compact` or a fresh session. Constants until the
/// settings file (docs/plan-settings.md) can hold them.
export const CONTEXT_LIMITS = { high: 150_000, over: 300_000 };

export type ContextLevel = "ok" | "high" | "over";

export function contextLevel(context: number): ContextLevel {
  if (context >= CONTEXT_LIMITS.over) return "over";
  if (context >= CONTEXT_LIMITS.high) return "high";
  return "ok";
}

/// The context figure's tooltip, saying why it is colored when it is.
export function contextTitle(context: number): string {
  const what = "Context: what the session's next turn starts from, and pays for";
  const level = contextLevel(context);
  if (level === "over") return `${what}\nOver ${formatTokens(CONTEXT_LIMITS.over)}: worth a /compact or a fresh session`;
  if (level === "high") return `${what}\nOver ${formatTokens(CONTEXT_LIMITS.high)}: getting large`;
  return what;
}

/// How long a working session's transcript may sit unwritten before the header
/// says so. Measured over this repo's 133 transcripts: of 3,700 tool calls the
/// slowest 1% passed 78 s and 9 passed 5 minutes, 7 of those running into Bash's
/// own 10-minute limit, and the slowest of 3,600 model replies took 249 s. So a
/// healthy session rarely goes this long, while waiting for Bash's limit would
/// leave a hung one unnoticed for 10 minutes. A subagent's writes count, so
/// delegating is not quiet. A build this long earns a misplaced `quiet`, which
/// says what was seen rather than that the agent is hung.
export const QUIET_AFTER_MS = 5 * 60_000;

/// How long a working session has gone without writing to its transcript, from
/// `QUIET_AFTER_MS` on: `6m`. Counted from when it started working if that is
/// later, as a session idle for an hour has an hour-old transcript the moment a
/// prompt arrives, up to a whole poll before the read sees that prompt's write.
/// Sessions are read every 15 s and each read redraws the strip, so the figure
/// is at most that late, well under the minutes it counts.
export function quietAge(usage: SessionUsage | null, status: StatusSince | undefined, now: number): string | null {
  if (status?.status !== "working" || usage?.written_at == null) return null;
  const quiet = now - Math.max(usage.written_at * 1000, status.since);
  return quiet < QUIET_AFTER_MS ? null : formatMinutes(Math.floor(quiet / 60_000));
}

/// The quiet figure's tooltip.
export function quietTitle(age: string): string {
  return `Working, but nothing written to its transcript for ${age}: a long tool call, or it may be hung`;
}

/// `950`, `14k`, `1.8M`.
export function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 999_500) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/// `opus-5-5` from `claude-opus-5-5`.
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "");
}

/// The spend figure's tooltip: what it counts and how.
export function spendTitle(tokens: Tokens, since: number): string {
  const from = new Date(since * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [
    `Spend since ${from}, the plan window's start, in fresh-input tokens`,
    `output ${formatTokens(tokens.output)} ×5`,
    `cache write ${formatTokens(tokens.cache_write_5m + tokens.cache_write_1h)} ×1.25 (5 min) / ×2 (1 h)`,
    `cache read ${formatTokens(tokens.cache_read)} ×0.1`,
    `input ${formatTokens(tokens.input)} ×1`,
  ].join("\n");
}
