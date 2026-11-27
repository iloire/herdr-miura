// Closing the loop with Todoist (docs/plan-todoist.md, idea 3): a prompt sent
// from a task leaves a link (task → the pane its agent runs in) in
// `todoist.jsonl` beside the outcome ledger, and that agent's outcomes are
// written back to the task: a verified `done` completes it and a `left` adds a
// subtask, both when asked; a `you` comments on it by itself. Pure, apart
// from the commands at the end, which `todoist.rs` carries out.

import { invoke } from "@tauri-apps/api/core";
import { isListed, isOpen, type Outcome } from "./ledger";

export interface TaskLink {
  task: string;
  title: string;
  pane: string;
  /// The checkout's commit when the prompt was sent.
  head: string | null;
  at: string;
}

export type Did = "closed" | "subtask" | "commented";

export interface Written {
  entry: string;
  task: string;
  did: Did | string;
  at: string;
}

export interface LinksFile {
  links: TaskLink[];
  written: Written[];
}

export const EMPTY_LINKS: LinksFile = { links: [], written: [] };

/// The task an outcome came from, and what was written back for it.
export interface Linked {
  link: TaskLink;
  written: ReadonlySet<string>;
}

/// The outcomes that end a turn's work on a task: after one, the pane's next
/// prompt is someone else's. A `you` waits, and the same work goes on.
const ENDS = new Set(["verified", "unverified", "left", "not-started"]);

/// Which ledger entries came from a linked task: an entry from a linked pane,
/// at or after the latest link there, until the first entry that ends the
/// work. The first entry's session claims the link, so a pane id the daemon
/// gives out again later does not match.
export function linkedOutcomes(list: readonly Outcome[], file: LinksFile): Map<string, Linked> {
  const byPane = new Map<string, { link: TaskLink; time: number }[]>();
  for (const link of file.links) {
    const time = Date.parse(link.at) || 0;
    byPane.set(link.pane, [...(byPane.get(link.pane) ?? []), { link, time }].sort((a, b) => a.time - b.time));
  }
  const written = new Map<string, Set<string>>();
  for (const w of file.written) written.set(w.entry, (written.get(w.entry) ?? new Set()).add(w.did));
  const state = new Map<TaskLink, { session: string; ended: boolean }>();
  const linked = new Map<string, Linked>();
  for (const outcome of [...list].sort((a, b) => a.time - b.time)) {
    const link = byPane
      .get(outcome.pane)
      ?.filter((l) => l.time <= outcome.time)
      .pop()?.link;
    if (!outcome.pane || !link) continue;
    const seen = state.get(link) ?? { session: "", ended: false };
    if (seen.ended || (seen.session && outcome.session && outcome.session !== seen.session)) continue;
    state.set(link, { session: seen.session || outcome.session, ended: ENDS.has(outcome.kind) });
    linked.set(outcome.id, { link, written: written.get(outcome.id) ?? new Set() });
  }
  return linked;
}

/// What can be written back for `outcome` when asked: completing its task, or
/// adding its parked note as a subtask. Null when nothing, or done already.
export function offer(outcome: Outcome, linked: Linked | undefined): "close" | "subtask" | null {
  if (!linked) return null;
  if (outcome.kind === "verified" && !linked.written.has("closed")) return "close";
  if (outcome.kind === "left" && isOpen(outcome) && !linked.written.has("subtask")) return "subtask";
  return null;
}

/// The asks to comment on their tasks unasked: open, recent, not yet commented.
export const toComment = (list: readonly Outcome[], linked: ReadonlyMap<string, Linked>) =>
  list.filter((o) => o.kind === "you" && isListed(o) && linked.has(o.id) && !linked.get(o.id)?.written.has("commented"));

const midnight = (now: number) => new Date(now).setHours(0, 0, 0, 0);

/// The offers the Day dialog shows, for the status bar to count: today's
/// dones, and the parked notes still listed.
export const offers = (list: readonly Outcome[], linked: ReadonlyMap<string, Linked>, now: number) =>
  list.filter((o) => offer(o, linked.get(o.id)) !== null && (o.kind === "left" ? isListed(o) : o.time >= midnight(now)));

/// The local day so far, in UTC as Todoist takes it: `2026-11-13T00:00:00Z`.
export function sinceMidnight(now: number): { since: string; until: string } {
  const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { since: iso(midnight(now)), until: iso(now) };
}

/// The task the latest prompt to any of `panes` came from, for a tab to link back to.
export function taskOfPanes(links: readonly TaskLink[], panes: readonly string[]): TaskLink | null {
  const want = new Set(panes);
  let latest: TaskLink | null = null;
  for (const link of links) {
    if (want.has(link.pane) && (!latest || (Date.parse(link.at) || 0) >= (Date.parse(latest.at) || 0))) latest = link;
  }
  return latest;
}

export const readLinks = () => invoke<LinksFile>("todoist_links");

/// Records that a prompt from `task` went to the agent in `pane`; `directory`
/// gives the commit it started from. Sent before the prompt, so no outcome can beat it.
export const linkTask = (task: { id: string; title: string }, pane: string, directory: string | null) =>
  invoke<void>("todoist_link", { task: task.id, title: task.title, pane, directory });

/// Writes `outcome` back to its task; false when it was already.
export const writeBack = (linked: Linked, outcome: Outcome) =>
  invoke<boolean>("todoist_write_back", { task: linked.link.task, entry: outcome, from: linked.link.head });

export const completedToday = (now: number) => invoke<number>("todoist_completed", sinceMidnight(now));
