import { type CSSProperties, useEffect, useState } from "react";
import type { Controller } from "../app/controller";
import { tildePath } from "../app/folder";
import { movedHome, readRecentSessions, type RecentSession, type SessionState, sessionState, sessionTabs } from "../app/recentSessions";
import { relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import type { Snapshot, Workspace } from "../protocol";

/// How often an open panel rereads: only files that changed cost anything.
const READ_MS = 10_000;

/// What a row's state says, when it says anything.
function stateWords(state: SessionState, session: RecentSession): string | null {
  switch (state.kind) {
    case "open":
      return "Open in a tab";
    case "opening":
      return "Opening…";
    case "elsewhere":
      return "Running in a terminal";
    case "gone":
      return "Folder removed";
    case "closed":
      return movedHome(session) ? "Worktree removed, opens in the main checkout" : null;
  }
}

/// The focused workspace's past Claude sessions in the right-hand drawer, newest
/// first. Clicking one resumes it in a new tab, or goes to the tab that has it.
export function SessionsPanel({
  controller,
  snapshot,
  workspace,
  hue,
  folders,
  resuming,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  /// The workspace's color.
  hue: string;
  /// Its root and worktrees; null when it is on another machine.
  folders: string[] | null;
  resuming: ReadonlySet<string>;
}) {
  const home = useHome();
  const key = folders?.join("\n") ?? "";
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);

  useEffect(() => {
    setSessions(null);
    setFailed(null);
  }, [key]);
  // Read again as a resume starts and ends: its session now counts as running.
  useEffect(() => {
    if (!key) return;
    const asked = key.split("\n");
    let live = true;
    const refresh = () => {
      readRecentSessions(asked)
        .then((next) => {
          if (!live) return;
          setSessions(next);
          setFailed(null);
        })
        .catch((error) => live && setFailed(String(error)));
    };
    refresh();
    const timer = window.setInterval(refresh, READ_MS);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key, resuming]);

  const head = (
    <span className="queue-head-title">
      Sessions {workspace && <b>{workspace.label}</b>}
    </span>
  );
  if (!workspace || !folders) {
    return (
      <aside className="changes sessions-panel" aria-label="Sessions">
        <header className="changes-head queue-head">{head}</header>
        <div className="queue-off">
          <p>Sessions are read from this Mac, so a workspace on another machine has none to show.</p>
        </div>
      </aside>
    );
  }

  const tabs = sessionTabs(snapshot);
  const queueRuns = sessions?.filter((session) => session.queue).length ?? 0;
  const shown = sessions?.filter((session) => showQueue || !session.queue) ?? [];
  const pick = (session: RecentSession, state: SessionState) => {
    if (state.kind === "open") controller.request("tab.focus", { tab_id: state.tabId });
    if (state.kind === "closed") controller.resumeSession(workspace.workspace_id, session.id);
  };

  return (
    <aside className="changes sessions-panel" aria-label="Sessions" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {failed && <div className="queue-banner" role="status">{failed}</div>}
      {queueRuns > 0 && (
        <label className="sessions-filter">
          <input type="checkbox" checked={showQueue} onChange={(event) => setShowQueue(event.target.checked)} />
          Show queue runs ({queueRuns})
        </label>
      )}
      {sessions && shown.length === 0 && (
        <div className="queue-off">
          <p>No Claude sessions in this workspace yet.</p>
        </div>
      )}
      <ul className="sessions-list">
        {shown.map((session) => {
          const state = sessionState(session, tabs, resuming);
          const words = stateWords(state, session);
          const live = state.kind === "open" || state.kind === "closed";
          const where = tildePath(session.opens_in ?? session.folder, home);
          const tip =
            state.kind === "gone"
              ? `${tildePath(session.folder, home)} no longer exists, so there is nowhere to open this session`
              : state.kind === "elsewhere"
                ? "A Claude Code outside Herdr has this session open. Close it there to resume it here"
                : movedHome(session)
                  ? `${tildePath(session.folder, home)} no longer exists. Resumes in ${where}`
                  : where;
          return (
            <li key={session.id}>
              <button className={`session-row ${state.kind}`} disabled={!live} title={tip} onClick={() => pick(session, state)}>
                <span className={session.title ? "session-title" : "session-title untitled"}>{session.title ?? "Untitled"}</span>
                <span className="session-prompt">{session.prompt}</span>
                <span className="session-meta">
                  {session.branch && <span className="session-branch">{session.branch}</span>}
                  <span>{relativeTime(session.updated_at)}</span>
                  {session.queue && <span>Queue run</span>}
                  {words && <span className="session-state">{words}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
