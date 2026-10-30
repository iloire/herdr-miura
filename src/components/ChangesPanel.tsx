import { useState, useSyncExternalStore } from "react";
import type { ChangedFile, ChangesStore, RecentCommit } from "../changes/store";
import type { SyncStore } from "../changes/sync";
import type { CommitFilesState } from "../changes/useCommitFiles";
import { ChangesSync } from "./ChangesSync";
import { CommitList, FileRow, type CommitRows, type DiffPick } from "./CommitList";

export type { DiffPick };

/// The checkout under the focused pane: branch, its sync with the remote,
/// changed files, recent commits. Picking a file opens its diff; picking a
/// commit opens its whole diff and lists its files under it, each jumping to
/// its part of the diff. `sync` is null on a remote host, where the panel has
/// no checkout to sync, so nothing of it shows there.
export function ChangesPanel({
  store,
  sync,
  selected,
  openCommit,
  commitFiles,
  onOpen,
  onToggleCommit,
}: {
  store: ChangesStore;
  sync: SyncStore | null;
  selected: DiffPick | null;
  openCommit: string | null;
  commitFiles: CommitFilesState | null;
  onOpen: (pick: DiffPick) => void;
  onToggleCommit: (commit: RecentCommit) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const checkout = state.phase === "ready" ? state.checkout : null;
  const isSelected = (file: ChangedFile, commit: string | null) =>
    selected?.file?.path === file.path && selected.commit === commit;
  // A commit can be listed twice, as outgoing and as recent. Only the list it
  // was opened from unfolds it.
  const [openedFrom, setOpenedFrom] = useState<"moving" | "recent">("recent");
  const rows = (from: "moving" | "recent"): CommitRows => ({
    openCommit: openedFrom === from ? openCommit : null,
    commitFiles,
    isSelected,
    onOpen,
    onToggle: (commit) => {
      setOpenedFrom(from);
      onToggleCommit(commit);
    },
  });
  return (
    <aside className="changes" aria-label="Changes">
      <header className="changes-head">
        <span>Changes</span>
      </header>
      {state.phase === "idle" && <p className="empty">Focus a pane to see its checkout.</p>}
      {state.phase === "loading" && <p className="empty">Reading the checkout…</p>}
      {state.phase === "failed" && <p className="empty error">Could not read the checkout: {state.error}</p>}
      {state.phase === "ready" && !checkout && <p className="empty">{state.directory} is not in a Git checkout.</p>}
      {checkout && (
        <>
          <div className="branch-line">
            <span className="branch">{checkout.branch ?? "detached HEAD"}</span>
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
          {sync && <ChangesSync key={checkout.path} store={sync} checkout={checkout} rows={rows("moving")} />}
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
              <CommitList commits={checkout.commits} rows={rows("recent")} />
            </>
          )}
        </>
      )}
    </aside>
  );
}
