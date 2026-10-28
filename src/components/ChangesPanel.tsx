import { useSyncExternalStore } from "react";
import type { ChangedFile, ChangesStore, RecentCommit } from "../changes/store";
import type { CommitFilesState } from "../changes/useCommitFiles";

function relativeTime(seconds: number): string {
  const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

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

function FileRow({ file, current, onOpen }: { file: ChangedFile; current: boolean; onOpen: () => void }) {
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

/// The checkout under the focused pane: branch, changed files, recent
/// commits. Picking a file opens its diff; picking a commit opens its whole
/// diff and lists its files under it, each jumping to its part of the diff.
export function ChangesPanel({
  store,
  selected,
  openCommit,
  commitFiles,
  onOpen,
  onToggleCommit,
  onClose,
}: {
  store: ChangesStore;
  selected: DiffPick | null;
  openCommit: string | null;
  commitFiles: CommitFilesState | null;
  onOpen: (pick: DiffPick) => void;
  onToggleCommit: (commit: RecentCommit) => void;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const checkout = state.phase === "ready" ? state.checkout : null;
  const isSelected = (file: ChangedFile, commit: string | null) =>
    selected?.file?.path === file.path && selected.commit === commit;
  return (
    <aside className="changes" aria-label="Changes">
      <header className="changes-head">
        <span>Changes</span>
        <button className="icon-button" aria-label="Close changes" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {state.phase === "idle" && <p className="empty">Focus a pane to see its checkout.</p>}
      {state.phase === "loading" && <p className="empty">Reading the checkout…</p>}
      {state.phase === "failed" && <p className="empty error">Could not read the checkout: {state.error}</p>}
      {state.phase === "ready" && !checkout && <p className="empty">{state.directory} is not in a Git checkout.</p>}
      {checkout && (
        <>
          <div className="branch-line">
            <span className="branch">{checkout.branch ?? "detached HEAD"}</span>
            {checkout.upstream && (checkout.ahead > 0 || checkout.behind > 0) && (
              <span className="counts" title={`Against ${checkout.upstream}`}>
                ↑{checkout.ahead} ↓{checkout.behind}
              </span>
            )}
            {checkout.unmerged && checkout.unmerged[1] > 0 && (
              <span className="counts" title={`Commits ${checkout.unmerged[0]} does not have`}>
                {checkout.unmerged[1]} not on {checkout.unmerged[0]}
              </span>
            )}
          </div>
          {/* Right-to-left so a long path loses its start, not its name;
              <bdi> keeps the path itself reading left to right. */}
          <div className="checkout-path" title={checkout.path}>
            <bdi>{checkout.path}</bdi>
          </div>
          <h3 className="changes-section">
            {checkout.total_files === 0 ? "No uncommitted changes" : `${checkout.total_files} changed`}
            {checkout.total_files > 0 && (
              <span className="lines">
                <span className="plus">+{checkout.added}</span> <span className="minus">−{checkout.removed}</span>
              </span>
            )}
          </h3>
          <ul className="file-list">
            {checkout.files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                current={isSelected(file, null)}
                onOpen={() => onOpen({ file, commit: null })}
              />
            ))}
          </ul>
          {checkout.total_files > checkout.files.length && (
            <p className="empty">and {checkout.total_files - checkout.files.length} more not listed</p>
          )}
          {checkout.commits.length > 0 && (
            <>
              <h3 className="changes-section">Recent commits</h3>
              <ul className="commit-list">
                {checkout.commits.map((commit) => {
                  const open = openCommit === commit.sha;
                  return (
                    <li key={commit.sha}>
                      <button
                        className="commit"
                        aria-expanded={open}
                        onClick={() => onToggleCommit(commit)}
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
                                <p className="empty">
                                  and {commitFiles.total_files - commitFiles.files.length} more not listed
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  );
}
