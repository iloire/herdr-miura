import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type MutableRefObject,
} from "react";
import { openFile } from "../app/agentFile";
import type { Controller } from "../app/controller";
import { absolutePath, canOpen } from "../changes/fileActions";
import { blobUrl, commitUrl, treeUrl, forgeName, onRemote, pushedBranch, type ForgeEntry, type ForgeStore } from "../changes/forge";
import type { ChangedFile, ChangesStore, CheckoutChanges, RecentCommit } from "../changes/store";
import type { SyncStore } from "../changes/sync";
import { ChangesSync } from "./ChangesSync";
import { ChangedFiles } from "./ChangedFiles";
import { CommitList, type CommitRows } from "./CommitList";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { ForgeLinks } from "./ForgeLinks";
import { BranchIcon, CodeIcon, CopyIcon, OpenIcon, QueueIcon, TrashIcon } from "./icons";

const NO_FORGE: ReadonlyMap<string, ForgeEntry> = new Map();
const noSubscription = () => () => {};
const noForge = () => NO_FORGE;

/// The checkout under the focused pane: branch, its sync with the remote,
/// changed files, recent commits. Picking a file opens its diff; picking a
/// commit opens it in the main area. `sync` is null on a remote host, where the panel has
/// no checkout to sync, so nothing of it shows there; `forge` too, as `gh` runs here.
/// With `origin` on GitHub or GitLab, the repository, branch, commits and files
/// link to their pages there.
export function ChangesPanel({
  controller,
  store,
  sync,
  forge,
  onAsk,
  selected,
  openCommit,
  listedCommits,
  onOpen,
  onToggleCommit,
  onDiscard,
  onCommitted,
}: {
  controller: Controller;
  store: ChangesStore;
  sync: SyncStore | null;
  /// GitHub's pull request and checks, through `gh`; null on a remote host.
  forge: ForgeStore | null;
  /// Adds a prompt to this workspace's queue; null where it has none.
  onAsk: ((prompt: string) => void) | null;
  selected: ChangedFile | null;
  openCommit: string | null;
  listedCommits: MutableRefObject<RecentCommit[]>;
  onOpen: (file: ChangedFile) => void;
  onToggleCommit: (commit: RecentCommit) => void;
  onDiscard: (file: ChangedFile) => void;
  onCommitted: () => void;
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
  const open = (url: string) => controller.act(openUrl(url));
  const web = checkout?.web ?? null;
  const pushed = checkout ? pushedBranch(checkout) : null;
  const head = checkout?.commits[0]?.sha ?? null;
  // Only a pushed branch can have a pull request or CI runs.
  const asks = forge && web?.kind === "github" && pushed && head && checkout ? checkout.path : null;
  useEffect(() => {
    if (!forge || !asks || !pushed || !head) return;
    const refresh = () => forge.refresh(asks, pushed, head);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [forge, asks, pushed, head]);
  const forgeEntry = useSyncExternalStore(forge?.subscribe ?? noSubscription, forge?.getState ?? noForge).get(asks ?? "");
  // An answer about another branch or commit says nothing about this one.
  const forgeStatus = forgeEntry && forgeEntry.key === `${pushed}@${head}` ? forgeEntry.status : null;
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
    if (checkout.web && pushed && onRemote(file.mark)) {
      const url = blobUrl(checkout.web, pushed, file.path);
      items.push({ label: `Open on ${forgeName(checkout.web)}`, icon: <OpenIcon />, onSelect: () => open(url) });
    }
    if (sync) items.push({ label: "Discard Changes…", icon: <TrashIcon />, onSelect: () => onDiscard(file) });
    return items;
  };
  const rows = (from: "moving" | "recent"): CommitRows => ({
    openCommit: openedFrom === from ? openCommit : null,
    listed: listedCommits,
    onToggle: (commit) => {
      setOpenedFrom(from);
      onToggleCommit(commit);
    },
    onMenu: (commit, event) => showMenu(event, commitMenu(commit)),
  });
  const commitMenu = (commit: RecentCommit): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "Copy SHA", icon: <CopyIcon />, onSelect: () => copy(commit.sha) },
      { label: "Copy Short SHA", icon: <CopyIcon />, onSelect: () => copy(commit.short) },
      { label: "Copy Subject", icon: <CopyIcon />, onSelect: () => copy(commit.subject) },
    ];
    if (web) {
      const url = commitUrl(web, commit.sha);
      items.push({ label: `Open on ${forgeName(web)}`, icon: <OpenIcon />, onSelect: () => open(url) });
    }
    if (onAsk && checkout) {
      const prompt = `Explain commit ${commit.sha} in ${checkout.path}: what it changes and why`;
      items.push({ label: "Ask Claude about This Commit", icon: <QueueIcon />, onSelect: () => onAsk(prompt) });
    }
    return items;
  };
  return (
    <aside className="changes" aria-label="Changes">
      <header className="changes-head">
        <span>Changes</span>
        {web && (
          <button className="forge-repo" title={`Open ${web.path} on ${forgeName(web)}`} onClick={() => open(web.url)}>
            <bdi>{web.path}</bdi>
            <OpenIcon />
          </button>
        )}
      </header>
      {state.phase === "idle" && <p className="empty">Focus a pane to see its checkout.</p>}
      {state.phase === "loading" && <p className="empty">Reading the checkout…</p>}
      {state.phase === "failed" && <p className="empty error">Could not read the checkout: {state.error}</p>}
      {state.phase === "ready" && !checkout && <p className="empty">{state.directory} is not in a Git checkout.</p>}
      {/* One key for everything of a checkout, so another checkout starts clean. */}
      {checkout && (
        <Fragment key={checkout.path}>
          {checkout.worktree_of && (
            <div className="worktree-band" title={`A linked worktree of ${checkout.worktree_of}, not its main checkout`}>
              <BranchIcon />
              <span>
                Worktree of <b>{checkout.worktree_of.split("/").pop()}</b>
              </span>
            </div>
          )}
          <div className="branch-line">
            {web && pushed ? (
              <button
                className="branch branch-link"
                title={`Open ${pushed} on ${forgeName(web)}`}
                onClick={() => open(treeUrl(web, pushed))}
              >
                {checkout.branch}
              </button>
            ) : (
              <span className="branch">{checkout.branch ?? "detached HEAD"}</span>
            )}
            {checkout.unmerged && checkout.unmerged[1] > 0 && (
              <span className="counts" title={`Commits ${checkout.unmerged[0]} does not have`}>
                {checkout.unmerged[1]} not on {checkout.unmerged[0]}
              </span>
            )}
          </div>
          {web && pushed && (
            <ForgeLinks web={web} checkout={checkout} branch={pushed} status={forgeStatus} open={open} />
          )}
          {/* Right-to-left so a long path loses its start, not its name;
              <bdi> keeps the path itself reading left to right. */}
          <div className="checkout-path" title={checkout.path}>
            <bdi>{checkout.path}</bdi>
          </div>
          {sync && <ChangesSync store={sync} checkout={checkout} rows={rows("moving")} />}
          <ChangedFiles
            checkout={checkout}
            sync={sync}
            selected={selected}
            onOpen={onOpen}
            onMenu={(event, file) => showMenu(event, fileMenu(checkout, file))}
            onCommitted={onCommitted}
          />
          {checkout.total_files > checkout.files.length && (
            <p className="empty">and {checkout.total_files - checkout.files.length} more not listed</p>
          )}
          {checkout.commits.length > 0 && (
            <>
              <h3 className="changes-section">Recent commits</h3>
              <CommitList
                commits={checkout.commits}
                rows={rows("recent")}
                checks={head && forgeStatus?.checks ? { sha: head, state: forgeStatus.checks } : undefined}
              />
            </>
          )}
        </Fragment>
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </aside>
  );
}
