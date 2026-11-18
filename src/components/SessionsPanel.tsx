import { type CSSProperties, type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { Controller } from "../app/controller";
import { tildePath } from "../app/folder";
import type { Outcome } from "../app/ledger";
import {
  byDay,
  isActive,
  latestOutcomes,
  movedHome,
  outcomeBadge,
  placeOf,
  readRecentSessions,
  type RecentSession,
  renameSession,
  type SessionPlace,
  type SessionState,
  sessionLabel,
  sessionState,
  sessionTabs,
  starSession,
} from "../app/recentSessions";
import { relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import type { Snapshot, Workspace } from "../protocol";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { RenameField } from "./RenameField";
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

/// The focused workspace's Claude sessions in the right-hand drawer, or every
/// workspace's: the starred ones, those with a Claude Code running, then the
/// history by day, each newest first. Clicking one goes to the tab that has it,
/// or shows its latest messages, where it can be resumed. The search runs on
/// the Rust side, which also reads each session's first prompt and commits.
export function SessionsPanel({
  controller,
  snapshot,
  workspace,
  hue,
  folders,
  places,
  outcomes,
  resuming,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  /// The workspace's color.
  hue: string;
  /// Its root and worktrees; null when it is on another machine.
  folders: string[] | null;
  /// This computer's workspaces, to say where a session from all of them goes.
  places: SessionPlace[];
  /// The outcome ledger's list, newest first.
  outcomes: Outcome[];
  resuming: ReadonlySet<string>;
}) {
  const home = useHome();
  const [all, setAll] = useState(false);
  const key = all ? "*" : (folders?.join("\n") ?? "");
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [unfinished, setUnfinished] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // Bumped after a star or a name, to read the list again.
  const [marked, setMarked] = useState(0);
  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    setSessions(null);
    setFailed(null);
    setPreviewing(null);
  }, [key]);
  // Read again as a resume starts and ends: its session now counts as running.
  useEffect(() => {
    if (!folders) return;
    const asked = all ? null : key.split("\n");
    let live = true;
    const refresh = () => {
      readRecentSessions(asked, query)
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
    // `folders` only says whether there are any; `key` carries them.
  }, [key, all, query, resuming, marked]);

  const latest = useMemo(() => latestOutcomes(outcomes), [outcomes]);

  const head = (
    <span className="queue-head-title">
      Sessions {all ? <b>All workspaces</b> : workspace && <b>{workspace.label}</b>}
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
  const badgeOf = (session: RecentSession) => outcomeBadge(latest.get(session.id));
  const shown = (sessions ?? []).filter((session) => !unfinished || badgeOf(session)?.unfinished);
  const starred = shown.filter((session) => session.starred);
  const active = shown.filter((session) => !session.starred && isActive(stateOf(session)));
  const history = shown.filter((session) => !session.starred && !isActive(stateOf(session)));
  const days = byDay(history, Date.now());
  const shownPreview = sessions?.find((session) => session.id === previewing) ?? null;
  const placeName = (session: RecentSession) => (all ? placeOf(session, places)?.label : null);

  const pick = (session: RecentSession, state: SessionState) => {
    if (state.kind === "open") controller.request("tab.focus", { tab_id: state.tabId });
    else setPreviewing(session.id);
  };
  const resume = (session: RecentSession) => {
    controller.resumeSession(placeOf(session, places)?.workspaceId ?? workspace.workspace_id, session.id);
  };
  const star = (session: RecentSession, starredNow: boolean) => {
    setSessions((list) => list && list.map((row) => (row.id === session.id ? { ...row, starred: starredNow } : row)));
    controller.act(starSession(session.id, starredNow).finally(() => setMarked((n) => n + 1)));
  };
  const rename = (session: RecentSession, name: string | null) => {
    setSessions((list) => list && list.map((row) => (row.id === session.id ? { ...row, name } : row)));
    controller.act(renameSession(session.id, name).finally(() => setMarked((n) => n + 1)));
  };
  const openMenu = (event: MouseEvent, session: RecentSession) => {
    event.preventDefault();
    const state = stateOf(session);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        [
          { label: state.kind === "open" ? "Go to tab" : "Show", onSelect: () => pick(session, state) },
          { label: session.starred ? "Unstar" : "Star", onSelect: () => star(session, !session.starred) },
        ],
        [
          { label: "Rename…", onSelect: () => setRenaming(session.id) },
          ...(session.name ? [{ label: "Clear name", hint: session.title ?? undefined, onSelect: () => rename(session, null) }] : []),
        ],
      ],
    });
  };

  const row = (session: RecentSession) => {
    const state = stateOf(session);
    const words = stateWords(state, session);
    const badge = badgeOf(session);
    const where = tildePath(session.opens_in ?? session.folder, home);
    const label = sessionLabel(session);
    const commit = session.commits[session.commits.length - 1];
    const place = placeName(session);
    const tip =
      state.kind === "gone"
        ? `${tildePath(session.folder, home)} no longer exists, so there is nowhere to open this session`
        : state.kind === "elsewhere"
          ? "A Claude Code outside Herdr has this session open. Close it there to resume it here"
          : movedHome(session)
            ? `${tildePath(session.folder, home)} no longer exists. Resumes in ${where}`
            : where;
    const meta = (
      <>
        {commit && (
          <span className="session-commit" title={session.commits.join("\n")}>
            {session.commits.length > 1 ? `${session.commits.length} commits · ${commit}` : commit}
          </span>
        )}
        <span className="session-meta">
          {place && <span className="session-place">{place}</span>}
          {session.branch && <span className="session-branch">{session.branch}</span>}
          <span>{relativeTime(session.updated_at)}</span>
          {session.queue && <span>Queue run</span>}
          {badge && <span className={badge.unfinished ? "session-outcome unfinished" : "session-outcome"}>{badge.words}</span>}
          {words && <span className="session-state">{words}</span>}
        </span>
      </>
    );
    return (
      <li key={session.id} className="session-item">
        {renaming === session.id ? (
          <div className={`session-row ${state.kind}`}>
            <RenameField
              className="session-rename"
              label="Session name"
              initial={label ?? session.prompt}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null && name !== label) rename(session, name);
              }}
            />
            <span className="session-prompt">{session.prompt}</span>
          </div>
        ) : (
          <button
            className={`session-row ${state.kind}`}
            disabled={state.kind === "opening"}
            title={tip}
            onClick={() => pick(session, state)}
            onContextMenu={(event) => openMenu(event, session)}
          >
            <span className={label ? "session-title" : "session-title untitled"}>{label ?? "Untitled"}</span>
            <span className="session-prompt">{session.prompt}</span>
            {meta}
          </button>
        )}
        <button
          className="session-star"
          aria-pressed={session.starred}
          aria-label={session.starred ? "Unstar" : "Star"}
          title={session.starred ? "Unstar" : "Star, to keep it at the top"}
          onClick={() => star(session, !session.starred)}
        >
          {session.starred ? "★" : "☆"}
        </button>
      </li>
    );
  };
  const group = (name: string, list: RecentSession[], className = "") =>
    list.length > 0 && (
      <section key={name} className={`sessions-group ${className}`}>
        <h3>{name}</h3>
        <ul>{list.map(row)}</ul>
      </section>
    );

  const empty = sessions?.length === 0 && !query.trim() && !all;
  return (
    <aside className="changes sessions-panel" aria-label="Sessions" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {failed && <div className="queue-banner" role="status">{failed}</div>}
      {empty ? (
        <div className="queue-off">
          <p>No Claude sessions in this workspace yet.</p>
        </div>
      ) : (
        <div className="files-filter sessions-filter">
          <input
            type="search"
            placeholder="Search sessions"
            title="Every word must be in its name, title, first or last prompt, branch, folder or commits"
            aria-label="Search sessions"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = [...starred, ...active, ...history].find((session) => stateOf(session).kind !== "opening");
                if (first) pick(first, stateOf(first));
              } else if (event.key === "Escape") {
                if (query) setQuery("");
                else controller.focusTerminal();
              } else return;
              event.preventDefault();
            }}
          />
          <button
            className="files-ignored"
            aria-pressed={unfinished}
            title="Only sessions whose last outcome left work for later or waits on you"
            onClick={() => setUnfinished(!unfinished)}
          >
            Unfinished
          </button>
          <button
            className="files-ignored"
            aria-pressed={all}
            title={all ? "Show this workspace's sessions" : "Show and search every workspace's sessions"}
            onClick={() => setAll(!all)}
          >
            All
          </button>
        </div>
      )}
      {sessions && shown.length === 0 && !empty && (
        <p className="empty">{query.trim() ? `No session holds “${query.trim()}”.` : "No unfinished sessions."}</p>
      )}
      <div className="sessions-list">
        {group("Starred", starred, "starred")}
        {group("Active", active, "active")}
        {days.map((day) => group(day.day, day.sessions))}
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {shownPreview && (
        <SessionPreviewDialog
          session={shownPreview}
          where={tildePath(shownPreview.opens_in ?? shownPreview.folder, home)}
          blocked={stateOf(shownPreview).kind === "closed" ? null : stateWords(stateOf(shownPreview), shownPreview)}
          movedHome={movedHome(shownPreview)}
          onStar={() => star(shownPreview, !shownPreview.starred)}
          onResume={() => {
            setPreviewing(null);
            resume(shownPreview);
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
