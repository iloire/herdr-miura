// The outcome ledger: every `herdr-outcome` an agent reported, kept by the
// external script in a file `ledger.rs` reads, so what a session left outlives
// its pane (docs/plan-inbox.md). Pure: what is open, parked or waiting on you.

import { invoke } from "@tauri-apps/api/core";

export type OutcomeKind = "verified" | "unverified" | "left" | "you" | "not-started";
export type ResolveHow = "queued" | "dismissed" | "todo" | "cleared";

export interface LedgerEntry {
  id: string;
  /// UTC, `2026-11-12T10:00:00Z`.
  at: string;
  kind: OutcomeKind | string;
  note: string;
  cwd: string;
  /// The main checkout of the repo it ran in, as `queue_homes` answers.
  home: string;
  branch: string;
  head: string;
  session: string;
  workspace: string;
  pane: string;
}

export interface Resolution {
  resolves: string;
  how: ResolveHow | string;
  at: string;
}

export interface Ledger {
  entries: LedgerEntry[];
  resolutions: Resolution[];
}

export interface Outcome extends LedgerEntry {
  /// `at` in ms.
  time: number;
  resolved: Resolution | null;
  /// A later entry from the same session took its place.
  superseded: boolean;
}

export const EMPTY_LEDGER: Ledger = { entries: [], resolutions: [] };

/// An outcome that waits on a person: `you`, and `not-started`, which says it
/// needs an answer first.
export const asksForYou = (kind: string) => kind === "you" || kind === "not-started";

/// Every entry, newest first, with what became of it.
export function outcomes(ledger: Ledger): Outcome[] {
  const resolved = new Map<string, Resolution>();
  for (const resolution of ledger.resolutions) resolved.set(resolution.resolves, resolution);
  const latest = new Map<string, number>();
  const list = ledger.entries.map((entry) => ({ ...entry, time: Date.parse(entry.at) || 0 }));
  for (const entry of list) {
    if (entry.session) latest.set(entry.session, Math.max(latest.get(entry.session) ?? 0, entry.time));
  }
  return list
    .map((entry) => ({
      ...entry,
      resolved: resolved.get(entry.id) ?? null,
      superseded: !!entry.session && (latest.get(entry.session) ?? 0) > entry.time,
    }))
    .sort((a, b) => b.time - a.time);
}

/// Something is still to be done about it: a `left` until it is queued or
/// dismissed, a `you` until it is cleared or its session reports again.
export function isOpen(outcome: Outcome): boolean {
  if (outcome.resolved) return false;
  if (outcome.kind === "left") return true;
  return asksForYou(outcome.kind) && !outcome.superseded;
}

/// The open `left` entries of one main checkout: its queue's Parked list.
export const parkedFor = (list: Outcome[], directory: string) =>
  list.filter((o) => o.kind === "left" && isOpen(o) && o.home === directory);

export const allParked = (list: Outcome[]) => list.filter((o) => o.kind === "left" && isOpen(o));

export const waitingOnYou = (list: Outcome[]) => list.filter((o) => asksForYou(o.kind) && isOpen(o));

/// What waits on you from a session no tab holds any more: the Agents section
/// and the tab's gold mark only know the live ones. An entry without a session
/// cannot be matched to a tab, so it counts.
export const waitingClosed = (list: Outcome[], live: ReadonlySet<string>) =>
  waitingOnYou(list).filter((o) => !o.session || !live.has(o.session));

const midnight = (now: number) => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

export const isDone = (kind: string) => kind === "verified" || kind === "unverified";

/// Tasks reported done today, local time.
export const doneToday = (list: Outcome[], now: number) => list.filter((o) => isDone(o.kind) && o.time >= midnight(now));

/// What the Day view lists: today's entries in local time, and whatever is
/// still open from before, grouped by repo, the repo with the latest first.
export function dayView(list: Outcome[], now: number): { home: string; outcomes: Outcome[] }[] {
  const shown = list.filter((o) => o.time >= midnight(now) || isOpen(o));
  const groups = new Map<string, Outcome[]>();
  for (const o of shown) groups.set(o.home, [...(groups.get(o.home) ?? []), o]);
  return [...groups].map(([home, outcomes]) => ({ home, outcomes }));
}

/// A parked note as a prompt a fresh session can act on alone.
export function parkedPrompt(outcome: Outcome): string {
  const where = outcome.branch ? ` on branch \`${outcome.branch}\`` : "";
  const lines = [outcome.note.trim(), "", `An earlier session left this for later${where}, ${outcome.at}.`];
  if (outcome.session) {
    lines.push(`Its transcript is ~/.claude/projects/*/${outcome.session}.jsonl, if you need what it knew.`);
  }
  return lines.join("\n");
}

/// The last folder of a path, to name a repo.
export const repoName = (home: string) => home.replace(/\/+$/, "").split("/").pop() || home;

export const readLedger = () => invoke<Ledger>("ledger_read");
export const resolveOutcome = (id: string, how: ResolveHow) => invoke<void>("ledger_resolve", { id, how });
