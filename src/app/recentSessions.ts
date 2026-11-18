import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../protocol";
import { asksForYou, isOpen, type Outcome } from "./ledger";
import type { Opened } from "./queue";
import { sessionOf } from "./sessionUsage";

// The Recent sessions panel and Reopen Closed Session. `recent_sessions.rs`
// reads the transcripts; which session is open in which tab is the snapshot's,
// and changes between reads, so it is decided here, as each row is drawn.

/// A session as the Rust side lists it.
export interface RecentSession {
  id: string;
  /// `/rename`'s name, else Claude Code's own title.
  title: string | null;
  /// The name given in Herdr, which goes before `title`.
  name: string | null;
  starred: boolean;
  prompt: string;
  /// The first thing typed.
  first_prompt: string | null;
  /// Titles of the commits it made, oldest first.
  commits: string[];
  branch: string | null;
  folder: string;
  /// Where a tab would open: `folder`, its main checkout when `folder` was a
  /// removed worktree, or null with nowhere to go.
  opens_in: string | null;
  /// Unix seconds.
  updated_at: number;
  queue: boolean;
  /// A Claude Code process has it open, in a tab or a plain terminal.
  running: boolean;
}

export type SessionState =
  | { kind: "closed" }
  | { kind: "open"; tabId: string }
  /// A tab for it is on its way.
  | { kind: "opening" }
  /// Open somewhere Herdr cannot go to, such as a plain terminal.
  | { kind: "elsewhere" }
  | { kind: "gone" };

/// A session's latest conversation, as the Rust side reads it.
export interface SessionPreview {
  /// Oldest first; what was typed and answered, without thinking or tools.
  messages: { from_user: boolean; text: string }[];
  model: string | null;
  context_tokens: number | null;
}

export const readSessionPreview = (session: string) => invoke<SessionPreview>("session_preview", { session });

/// The sessions of `folders`, or of every folder when null, whose name, titles,
/// prompts, branch, folder or commits hold every word of `query`.
export const readRecentSessions = (folders: string[] | null, query = "") => invoke<RecentSession[]>("recent_sessions", { folders, query });

export const starSession = (session: string, starred: boolean) => invoke("session_star", { session, starred });

/// Null or an empty name takes the name off.
export const renameSession = (session: string, name: string | null) => invoke("session_rename", { session, name });

/// What a row is called.
export const sessionLabel = (session: RecentSession) => session.name ?? session.title;

/// Opens a tab running `claude --resume`, in front, in the folder the transcript says.
export const resumeInNewTab = (workspaceId: string, session: string) => invoke<Opened>("session_resume", { workspaceId, session });

/// A workspace's folders: its root and its worktrees.
export function sessionFolders(root: string | null, worktrees: readonly { path: string }[]): string[] | null {
  return root ? [root, ...worktrees.map((worktree) => worktree.path)] : null;
}

/// The tab each session is open in, across every workspace. Going by the
/// agents, the snapshot's live list, so a tab whose Claude has exited holds none.
export function sessionTabs(snapshot: Snapshot): Map<string, string> {
  const tabs = new Map<string, string>();
  for (const agent of snapshot.agents) {
    const session = sessionOf(agent);
    if (session) tabs.set(session, agent.tab_id);
  }
  return tabs;
}

/// What a click on a session's row can do. A tab comes first: `running` is true
/// for that session too, and a tab can be gone to.
export function sessionState(session: RecentSession, tabs: ReadonlyMap<string, string>, resuming: ReadonlySet<string>): SessionState {
  const tabId = tabs.get(session.id);
  if (tabId) return { kind: "open", tabId };
  if (resuming.has(session.id)) return { kind: "opening" };
  if (session.running) return { kind: "elsewhere" };
  return session.opens_in ? { kind: "closed" } : { kind: "gone" };
}

/// Whether a Claude Code has the session, or is about to. The rest is history.
export const isActive = (state: SessionState) => state.kind === "open" || state.kind === "opening" || state.kind === "elsewhere";

/// Whether the session opens somewhere other than where it last worked.
export const movedHome = (session: RecentSession) => session.opens_in !== null && session.opens_in !== session.folder;

/// The day group a time falls in, by this computer's calendar.
export type Day = "Today" | "Yesterday" | "This week" | "This month" | "Older";

const DAY_MS = 86_400_000;

/// `updated_at` (Unix seconds) by the calendar day of `now` (ms): the week
/// starts on Monday.
export function dayOf(updatedAt: number, now: number): Day {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  const at = updatedAt * 1000;
  if (at >= start) return "Today";
  if (at >= start - DAY_MS) return "Yesterday";
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  if (at >= weekStart.getTime()) return "This week";
  if (at >= new Date(today.getFullYear(), today.getMonth(), 1).getTime()) return "This month";
  return "Older";
}

/// `sessions`, already newest first, cut into runs of one day group each.
export function byDay(sessions: readonly RecentSession[], now: number): { day: Day; sessions: RecentSession[] }[] {
  const groups: { day: Day; sessions: RecentSession[] }[] = [];
  for (const session of sessions) {
    const day = dayOf(session.updated_at, now);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.sessions.push(session);
    else groups.push({ day, sessions: [session] });
  }
  return groups;
}

/// Each session's latest `herdr-outcome`, from the ledger's list, newest first.
export function latestOutcomes(list: readonly Outcome[]): Map<string, Outcome> {
  const latest = new Map<string, Outcome>();
  for (const outcome of list) if (outcome.session && !latest.has(outcome.session)) latest.set(outcome.session, outcome);
  return latest;
}

/// What a session's latest outcome says on its row: whether it was left
/// unfinished, and so is worth coming back to.
export function outcomeBadge(outcome: Outcome | undefined): { words: string; unfinished: boolean } | null {
  if (!outcome) return null;
  if (isOpen(outcome)) return { words: asksForYou(outcome.kind) ? "Waiting on you" : "Left for later", unfinished: true };
  if (outcome.kind === "verified") return { words: "Done", unfinished: false };
  return null;
}

/// A workspace, with the folders whose sessions are its own.
export interface SessionPlace {
  workspaceId: string;
  label: string;
  folders: string[];
}

const under = (folder: string, parent: string) => {
  const root = parent.replace(/\/+$/, "");
  return folder === root || folder.startsWith(`${root}/`);
};

/// The workspace a session worked in: the one with the deepest folder holding it.
export function placeOf(session: RecentSession, places: readonly SessionPlace[]): SessionPlace | null {
  let best: { place: SessionPlace; depth: number } | null = null;
  for (const place of places) {
    for (const folder of place.folders) {
      if (under(session.folder, folder) && (!best || folder.length > best.depth)) best = { place, depth: folder.length };
    }
  }
  return best?.place ?? null;
}

/// What Reopen Closed Session resumes: the newest closed session of the list.
/// Not a queue run, which a person closes in batches when it is done, nor one
/// whose worktree has gone, which was most likely landed.
export function reopenTarget(sessions: readonly RecentSession[], tabs: ReadonlyMap<string, string>, resuming: ReadonlySet<string>): RecentSession | null {
  const closed = (session: RecentSession) => sessionState(session, tabs, resuming).kind === "closed";
  return sessions.find((session) => !session.queue && !movedHome(session) && closed(session)) ?? null;
}
