import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../protocol";
import type { Opened } from "./queue";
import { sessionOf } from "./sessionUsage";

// The Recent sessions panel and Reopen Closed Session. `recent_sessions.rs`
// reads the transcripts; which session is open in which tab is the snapshot's,
// and changes between reads, so it is decided here, as each row is drawn.

/// A session as the Rust side lists it.
export interface RecentSession {
  id: string;
  title: string | null;
  prompt: string;
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

export const readRecentSessions = (folders: string[]) => invoke<RecentSession[]>("recent_sessions", { folders });

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

/// What Reopen Closed Session resumes: the newest closed session of the list.
/// Not a queue run, which a person closes in batches when it is done, nor one
/// whose worktree has gone, which was most likely landed.
export function reopenTarget(sessions: readonly RecentSession[], tabs: ReadonlyMap<string, string>, resuming: ReadonlySet<string>): RecentSession | null {
  const closed = (session: RecentSession) => sessionState(session, tabs, resuming).kind === "closed";
  return sessions.find((session) => !session.queue && !movedHome(session) && closed(session)) ?? null;
}
