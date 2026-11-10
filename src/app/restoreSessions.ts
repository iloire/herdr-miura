import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../protocol";
import type { Opened } from "./queue";
import { sessionOf } from "./sessionUsage";

// Resuming the sessions a restart of the daemon took. Herdr restores each pane,
// with its id and folder, but not the Claude Code in it. So every window keeps
// a record of which session each pane holds (`open_sessions.rs`, one file all
// windows share), and the first window to see a new boot gets the old boot's
// panes back, once, and resumes each in the pane it was in.

/// A pane and the session it holds, as `open_sessions.rs` keeps it.
export interface OpenSession {
  session: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  cwd: string;
}

/// Saves `panes` for `bootId`; returns the boot before's panes on a new boot.
export const syncOpenSessions = (bootId: string, panes: OpenSession[]) =>
  invoke<OpenSession[]>("open_sessions_sync", { bootId, panes });

/// Runs `claude --resume` in a pane already open.
export const resumeInPane = (entry: OpenSession) =>
  invoke<Opened>("session_resume_in", { session: entry.session, tabId: entry.tab_id, paneId: entry.pane_id });

/// Each live Claude Code session and the pane it runs in, in a fixed order so
/// two snapshots holding the same compare equal.
export function openSessions(snapshot: Snapshot): OpenSession[] {
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const open: OpenSession[] = [];
  for (const agent of snapshot.agents) {
    const session = sessionOf(agent);
    const pane = panes.get(agent.pane_id);
    const cwd = pane?.cwd || pane?.foreground_cwd;
    if (session && cwd) {
      open.push({ session, workspace_id: agent.workspace_id, tab_id: agent.tab_id, pane_id: agent.pane_id, cwd });
    }
  }
  return open.sort((a, b) => a.pane_id.localeCompare(b.pane_id));
}

/// The saved panes that can be resumed where they were: the same pane, in the
/// same tab and folder, with no agent in it now. A pane that is gone was most
/// likely closed on purpose, so it is left to the Sessions panel.
export function restorable(saved: readonly OpenSession[], snapshot: Snapshot): OpenSession[] {
  const busy = new Set(snapshot.agents.map((agent) => agent.pane_id));
  const running = new Set(snapshot.agents.map(sessionOf));
  const seen = new Set<string>();
  return saved.filter((entry) => {
    const pane = snapshot.panes.find((pane) => pane.pane_id === entry.pane_id);
    const same =
      pane &&
      pane.tab_id === entry.tab_id &&
      pane.workspace_id === entry.workspace_id &&
      (pane.cwd === entry.cwd || pane.foreground_cwd === entry.cwd);
    if (!same || busy.has(entry.pane_id) || running.has(entry.session) || seen.has(entry.session)) return false;
    seen.add(entry.session);
    return true;
  });
}
