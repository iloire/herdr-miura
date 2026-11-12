// What a row in a commit list shows beyond the commit itself: who made it,
// which day it falls under, how big it is, and whether the filter keeps it.

import type { RecentCommit } from "./store";

/// Two letters for an author, as several machines and agents commit to one
/// checkout: the first and last word's initials, or a lone word's first two.
export function initials(author: string): string {
  const words = author
    .split(/[\s._@-]+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length === 0) return "?";
  const letters =
    words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join("").toUpperCase();
}

/// A hue for an author, the same on every row and every run.
export function authorHue(author: string): number {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

export type Day = "Today" | "Yesterday" | "This week" | "Older";

const DAY_MS = 86_400_000;

/// Local midnight at the start of `date`'s day.
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/// Which separator a commit at `seconds` sits under, seen from `now`. "This
/// week" is the five days before yesterday; a commit dated in the future, as
/// a clock ahead of this one makes, counts as today.
export function dayOf(seconds: number, now: Date): Day {
  const today = startOfDay(now);
  const at = seconds * 1000;
  if (at >= today) return "Today";
  if (at >= today - DAY_MS) return "Yesterday";
  if (at >= today - 6 * DAY_MS) return "This week";
  return "Older";
}

export interface DayGroup {
  day: Day;
  commits: RecentCommit[];
}

/// Runs of commits under one day each, in the list's own order. Committer
/// times are not always in that order (a rebase or a cherry-pick keeps old
/// ones), so a day can head more than one run rather than move a commit.
export function groupByDay(commits: RecentCommit[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const commit of commits) {
    const day = dayOf(commit.time, now);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.commits.push(commit);
    else groups.push({ day, commits: [commit] });
  }
  return groups;
}

/// The time on a row, which its day separator already dates: the clock today
/// and yesterday, the weekday this week, the date before that.
export function rowTime(seconds: number, day: Day): string {
  const date = new Date(seconds * 1000);
  switch (day) {
    case "Today":
    case "Yesterday":
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    case "This week":
      return date.toLocaleDateString([], { weekday: "short" });
    case "Older":
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

/// The commits whose subject holds `query`, ignoring case; all of them for a blank one.
export function filterCommits(commits: RecentCommit[], query: string): RecentCommit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return commits;
  return commits.filter((commit) => commit.subject.toLocaleLowerCase().includes(needle));
}

/// The widest a commit's lines bar gets, in pixels.
export const BAR_WIDTH = 28;

/// A commit's lines bar: its length grows with the log of the lines changed,
/// so a one-line fix and a thousand-line one both read, and it splits
/// between added and removed. Null for a commit with nothing counted.
export function lineBar(additions: number | null, deletions: number | null): { plus: number; minus: number } | null {
  if (additions === null || deletions === null) return null;
  const total = additions + deletions;
  if (total === 0) return null;
  const length = Math.max(3, Math.min(BAR_WIDTH, Math.round((Math.log10(total + 1) / 3) * BAR_WIDTH)));
  const plus = Math.round((length * additions) / total);
  return { plus, minus: length - plus };
}
