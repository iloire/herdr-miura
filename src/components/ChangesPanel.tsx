import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useState, useSyncExternalStore, type MouseEvent, type MutableRefObject } from "react";
import { openFile } from "../app/agentFile";
import type { Controller } from "../app/controller";
import { absolutePath, canOpen } from "../changes/fileActions";
import type { ChangedFile, ChangesStore, CheckoutChanges, RecentCommit } from "../changes/store";
import type { SyncStore } from "../changes/sync";
import { ChangesSync } from "./ChangesSync";
import { CommitList, FileRow, type CommitRows } from "./CommitList";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { CodeIcon, CopyIcon } from "./icons";

/// The checkout under the focused pane: branch, its sync with the remote,
/// changed files, recent commits. Picking a file opens its diff; picking a
/// commit opens it in the main area. `sync` is null on a remote host, where the panel has
/// no checkout to sync, so nothing of it shows there.
export function ChangesPanel({
  controller,
  store,
  sync,
  selected,
  openCommit,
  listedCommits,
  onOpen,
  onToggleCommit,
}: {
  controller: Controller;
  store: ChangesStore;
  sync: SyncStore | null;
  selected: ChangedFile | null;
  openCommit: string | null;
  listedCommits: MutableRefObject<RecentCommit[]>;
  onOpen: (file: ChangedFile) => void;
  onToggleCommit: (commit: RecentCommit) => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const checkout = state.phase === "ready" ? state.checkout : null;
  // A commit can be listed twice, as outgoing and as recent. Only the list it
  // was opened from marks it.
  const [openedFrom, setOpenedFrom] = useState<"moving" | "recent">("recent");
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const showMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  const copy = (text: string) => controller.act(writeText(text));
  // Opening needs this Mac, so a checkout read before moving to a remote host offers only the copy.
  const fileMenu = (checkout: CheckoutChanges, file: ChangedFile): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Copy Path", icon: <CopyIcon />, onSelect: () => copy(absolutePath(checkout.path, file.path)) },
    ];
    if (sync && canOpen(file)) {
      items.push({
        label: "Open in VS Code",
        icon: <CodeIcon />,
        onSelect: () => controller.act(openFile(checkout.path, file.path)),
      });
    }
    return items;
  };
  const rows = (from: "moving" | "recent"): CommitRows => ({
    openCommit: openedFrom === from ? openCommit : null,
    listed: listedCommits,
    onToggle: (commit) => {
      setOpenedFrom(from);
      onToggleCommit(commit);
    },
    onMenu: (commit, event) =>
      showMenu(event, [{ label: "Copy SHA", icon: <CopyIcon />, onSelect: () => copy(commit.sha) }]),
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
                current={selected?.path === file.path}
                onOpen={() => onOpen(file)}
                onMenu={(event) => showMenu(event, fileMenu(checkout, file))}
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
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </aside>
  );
}
