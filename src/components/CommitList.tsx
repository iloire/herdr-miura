import { useEffect, useRef, type MouseEvent, type MutableRefObject } from "react";
import type { ChangedFile, RecentCommit } from "../changes/store";
import { relativeTime } from "../app/time";

const MARK_LABEL: Record<string, string> = {
  "?": "Untracked",
  A: "Added",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  U: "Conflicted",
};

export function FileRow({
  file,
  current,
  onOpen,
  onMenu,
  tick,
}: {
  file: ChangedFile;
  current: boolean;
  onOpen: () => void;
  /// A commit's own files have nothing to act on, so they have no menu.
  onMenu?: (event: MouseEvent) => void;
  /// The row's tick box, where it can be committed.
  tick?: { checked: boolean; onChange: () => void };
}) {
  return (
    <li className={tick ? "file-tickable" : undefined}>
      {tick && (
        <input
          type="checkbox"
          className="file-tick"
          aria-label={`Include ${file.path} in the commit`}
          checked={tick.checked}
          onChange={tick.onChange}
        />
      )}
      <button
        className="file"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        onContextMenu={onMenu}
        title={`${MARK_LABEL[file.mark] ?? file.mark}: ${file.path}`}
      >
        <span className={`mark mark-${file.mark === "?" ? "untracked" : file.mark}`}>{file.mark}</span>
        <span className="file-name">
          <span className="base">{file.path.split("/").pop()}</span>
          <span className="dir">{file.path.split("/").slice(0, -1).join("/")}</span>
        </span>
        {file.additions !== null && (
          <span className="lines">
            <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
          </span>
        )}
      </button>
    </li>
  );
}

/// What every list of commits shares: the one open, and the pick. `listed`
/// holds the list it was picked from, for stepping along it.
export interface CommitRows {
  openCommit: string | null;
  listed: MutableRefObject<RecentCommit[]>;
  onToggle: (commit: RecentCommit) => void;
  onMenu: (commit: RecentCommit, event: MouseEvent) => void;
}

/// Commits as one-line rows. Picking one opens it in the main area.
export function CommitList({ commits, rows }: { commits: RecentCommit[]; rows: CommitRows }) {
  const { openCommit, listed, onToggle, onMenu } = rows;
  const openRow = useRef<HTMLButtonElement>(null);
  const holdsOpen = commits.some((commit) => commit.sha === openCommit);
  useEffect(() => {
    if (holdsOpen) listed.current = commits;
  }, [holdsOpen, commits, listed]);
  // Arrow keys step from the main area, so the row must follow them here.
  useEffect(() => openRow.current?.scrollIntoView({ block: "nearest" }), [openCommit]);
  return (
    <ul className="commit-list">
      {commits.map((commit) => {
        const open = openCommit === commit.sha;
        return (
          <li key={commit.sha}>
            <button
              ref={open ? openRow : undefined}
              className="commit"
              aria-current={open ? "true" : undefined}
              onClick={() => onToggle(commit)}
              onContextMenu={(event) => onMenu(commit, event)}
              title={`${commit.sha}\n${commit.author}`}
            >
              <span className="sha">{commit.short}</span>
              <span className="subject">{commit.subject}</span>
              <span className="when">{relativeTime(commit.time)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
