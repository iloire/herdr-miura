import type { ChangedFile, RecentCommit } from "../changes/store";
import type { CommitFilesState } from "../changes/useCommitFiles";
import { relativeTime } from "../app/time";

const MARK_LABEL: Record<string, string> = {
  "?": "Untracked",
  A: "Added",
  D: "Deleted",
  M: "Modified",
  R: "Renamed",
  U: "Conflicted",
};

/// What the diff shows: a file's uncommitted change, or with `commit` (a
/// full name), every file that commit changed, scrolled to `file` if set.
export type DiffPick = { file: ChangedFile; commit: null } | { file: ChangedFile | null; commit: string };

export function FileRow({ file, current, onOpen }: { file: ChangedFile; current: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        className="file"
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
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

/// What every list of commits shares: the one open, its files, and the picks.
export interface CommitRows {
  openCommit: string | null;
  commitFiles: CommitFilesState | null;
  isSelected: (file: ChangedFile, commit: string | null) => boolean;
  onOpen: (pick: DiffPick) => void;
  onToggle: (commit: RecentCommit) => void;
}

/// Commits as rows. Picking one opens its whole diff and lists its files
/// under it, each jumping to its part of the diff.
export function CommitList({ commits, rows }: { commits: RecentCommit[]; rows: CommitRows }) {
  const { openCommit, commitFiles, isSelected, onOpen, onToggle } = rows;
  return (
    <ul className="commit-list">
      {commits.map((commit) => {
        const open = openCommit === commit.sha;
        return (
          <li key={commit.sha}>
            <button
              className="commit"
              aria-expanded={open}
              onClick={() => onToggle(commit)}
              title={`${commit.sha}\n${commit.author}`}
            >
              <span className="sha">{commit.short}</span>
              <span className="subject">{commit.subject}</span>
              <span className="when">{relativeTime(commit.time)}</span>
            </button>
            {open && (
              <div className="commit-detail">
                <p className="commit-subject">{commit.subject}</p>
                <p className="commit-author">{commit.author}</p>
                {commitFiles?.phase === "loading" && <p className="empty">Reading the commit…</p>}
                {commitFiles?.phase === "failed" && (
                  <p className="empty error">Could not read the commit: {commitFiles.error}</p>
                )}
                {commitFiles?.phase === "ready" && (
                  <>
                    <ul className="file-list">
                      {commitFiles.files.map((file) => (
                        <FileRow
                          key={file.path}
                          file={file}
                          current={isSelected(file, commit.sha)}
                          onOpen={() => onOpen({ file, commit: commit.sha })}
                        />
                      ))}
                    </ul>
                    {commitFiles.total_files > commitFiles.files.length && (
                      <p className="empty">and {commitFiles.total_files - commitFiles.files.length} more not listed</p>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
