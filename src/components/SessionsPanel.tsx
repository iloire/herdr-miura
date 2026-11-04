import { type CSSProperties, useEffect, useState } from "react";
import type { Controller } from "../app/controller";
import { tildePath } from "../app/folder";
import { isActive, matchingSessions, movedHome, readRecentSessions, type RecentSession, type SessionState, sessionState, sessionTabs } from "../app/recentSessions";
import { relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import type { Snapshot, Workspace } from "../protocol";
import { SessionPreviewDialog } from "./SessionPreviewDialog";

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

/// The focused workspace's Claude sessions in the right-hand drawer: those with
/// a Claude Code running, then the history, each newest first. Clicking one goes
/// to the tab that has it, or shows its latest messages, where it can be resumed.
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
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setSessions(null);
    setFailed(null);
    setPreviewing(null);
    setQuery("");
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
          <p>Sessions are read from this computer, so a workspace on another machine has none to show.</p>
        </div>
      </aside>
    );
  }

  const tabs = sessionTabs(snapshot);
  const stateOf = (session: RecentSession) => sessionState(session, tabs, resuming);
  const shown = matchingSessions(sessions ?? [], query);
  const active = shown.filter((session) => isActive(stateOf(session)));
  const history = shown.filter((session) => !isActive(stateOf(session)));
  const shownPreview = sessions?.find((session) => session.id === previewing) ?? null;
  const pick = (session: RecentSession, state: SessionState) => {
    if (state.kind === "open") controller.request("tab.focus", { tab_id: state.tabId });
    else setPreviewing(session.id);
  };
  const row = (session: RecentSession) => {
    const state = stateOf(session);
    const words = stateWords(state, session);
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
        <button className={`session-row ${state.kind}`} disabled={state.kind === "opening"} title={tip} onClick={() => pick(session, state)}>
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
  };

  return (
    <aside className="changes sessions-panel" aria-label="Sessions" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {failed && <div className="queue-banner" role="status">{failed}</div>}
      {sessions?.length === 0 ? (
        <div className="queue-off">
          <p>No Claude sessions in this workspace yet.</p>
        </div>
      ) : (
        <div className="files-filter">
          <input
            type="search"
            placeholder="Filter sessions"
            aria-label="Filter sessions"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = [...active, ...history].find((session) => stateOf(session).kind !== "opening");
                if (first) pick(first, stateOf(first));
              } else if (event.key === "Escape") {
                if (query) setQuery("");
                else controller.focusTerminal();
              } else return;
              event.preventDefault();
            }}
          />
        </div>
      )}
      {sessions && sessions.length > 0 && shown.length === 0 && <p className="empty">No session holds “{query.trim()}”.</p>}
      <div className="sessions-list">
        {active.length > 0 && (
          <section className="sessions-group active">
            <h3>Active</h3>
            <ul>{active.map(row)}</ul>
          </section>
        )}
        {history.length > 0 && (
          <section className="sessions-group">
            <h3>History</h3>
            <ul>{history.map(row)}</ul>
          </section>
        )}
      </div>
      {shownPreview && (
        <SessionPreviewDialog
          session={shownPreview}
          where={tildePath(shownPreview.opens_in ?? shownPreview.folder, home)}
          blocked={stateOf(shownPreview).kind === "closed" ? null : stateWords(stateOf(shownPreview), shownPreview)}
          movedHome={movedHome(shownPreview)}
          onResume={() => {
            setPreviewing(null);
            controller.resumeSession(workspace.workspace_id, shownPreview.id);
          }}
          onClose={() => {
            setPreviewing(null);
            controller.focusTerminal();
          }}
        />
      )}
    </aside>
  );
}
