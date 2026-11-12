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
import { openFolder } from "../app/folder";
import { relativeTime } from "../app/time";
import { checkoutCommit, commitBlock, revertBlock } from "../changes/commitActions";
import { filterCommits } from "../changes/commitRows";
import { absolutePath, canOpen } from "../changes/fileActions";
import { blobUrl, commitUrl, treeUrl, forgeName, onRemote, pushedBranch, type ForgeEntry, type ForgeStore } from "../changes/forge";
import {
  MAX_COMMITS,
  fileHistory,
  type ChangedFile,
  type ChangesStore,
  type CheckoutChanges,
  type RecentCommit,
} from "../changes/store";
import type { SyncStore } from "../changes/sync";
import { BranchList } from "./BranchList";
import { ChangesSync } from "./ChangesSync";
import { ChangedFiles } from "./ChangedFiles";
import { CommitActionDialog, type CommitAction } from "./CommitActionDialog";
import { CommitList, type CommitRows } from "./CommitList";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { ForgeLinks } from "./ForgeLinks";
import {
  BranchIcon,
  ChevronIcon,
  CodeIcon,
  CommitIcon,
  CopyIcon,
  FolderIcon,
  HistoryIcon,
  OpenIcon,
  QueueIcon,
  RevertIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";

const NO_FORGE: ReadonlyMap<string, ForgeEntry> = new Map();
const noSubscription = () => () => {};
const noForge = () => NO_FORGE;

/// One file's last commits, shown in place of the recent ones.
interface History {
  checkout: string;
  path: string;
  commits: RecentCommit[] | null;
  error: string | null;
}

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
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [acting, setActing] = useState<{ action: CommitAction; commit: RecentCommit; checkout: string } | null>(null);
  // The filter and the branch list belong to one checkout, so another starts without them.
  const [scope, setScope] = useState(checkout?.path ?? null);
  if (checkout && checkout.path !== scope) {
    setScope(checkout.path);
    setFilter("");
    setBranchesOpen(false);
  }
  const closeMenu = useCallback(() => setMenu(null), []);
  const showMenu = (event: MouseEvent, items: MenuItem[] | MenuItem[][]) => {
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
    if (file.mark !== "?" && file.mark !== "A" && checkout.born) {
      items.push({ label: "History", icon: <HistoryIcon />, onSelect: () => showHistory(checkout.path, file.path) });
    }
    if (sync) items.push({ label: "Discard Changes…", icon: <TrashIcon />, onSelect: () => onDiscard(file) });
    return items;
  };
  const showHistory = (path: string, file: string) => {
    setHistory({ checkout: path, path: file, commits: null, error: null });
    const settle = (update: Partial<History>) =>
      setHistory((shown) => (shown?.checkout === path && shown.path === file ? { ...shown, ...update } : shown));
    fileHistory(path, file).then(
      (commits) => settle({ commits }),
      (error) => settle({ error: String(error) }),
    );
  };
  const shownHistory = history && checkout && history.checkout === checkout.path ? history : null;
  const newTab = (path: string) => {
    const workspaceId = controller.getState().snapshot?.focused_workspace_id;
    if (workspaceId) controller.request("tab.create", { workspace_id: workspaceId, cwd: path, focus: true });
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
  /// Detaching asks nothing, as it loses nothing: the tree is clean, and the
  /// branch is still there to switch back to.
  const detach = async (path: string, commit: RecentCommit) => {
    try {
      const outcome = await checkoutCommit(path, commit.sha);
      if (outcome.kind === "failed") {
        controller.alert("Nothing was checked out", [outcome.message, outcome.details].filter(Boolean).join("\n\n"));
      }
    } catch (error) {
      controller.alert("Nothing was checked out", String(error));
    }
    onCommitted();
  };
  const commitMenu = (commit: RecentCommit): MenuItem[][] => {
    const copies: MenuItem[] = [
      { label: "Copy SHA", icon: <CopyIcon />, onSelect: () => copy(commit.sha) },
      { label: "Copy Short SHA", icon: <CopyIcon />, onSelect: () => copy(commit.short) },
      { label: "Copy Subject", icon: <CopyIcon />, onSelect: () => copy(commit.subject) },
    ];
    if (web) {
      const url = commitUrl(web, commit.sha);
      copies.push({ label: `Open on ${forgeName(web)}`, icon: <OpenIcon />, onSelect: () => open(url) });
    }
    // Writes need this Mac, so a remote host's checkout offers none.
    const writes: MenuItem[] = [];
    if (sync && checkout) {
      const path = checkout.path;
      const block = commitBlock(checkout);
      const revert = revertBlock(checkout);
      writes.push(
        {
          label: "Check Out (Detached)",
          icon: <CommitIcon />,
          disabled: block !== null,
          hint: block ?? undefined,
          onSelect: () => void detach(path, commit),
        },
        {
          label: "New Branch Here…",
          icon: <BranchIcon />,
          disabled: block !== null,
          hint: block ?? undefined,
          onSelect: () => setActing({ action: "branch", commit, checkout: path }),
        },
        {
          label: "Revert…",
          icon: <RevertIcon />,
          disabled: revert !== null,
          hint: revert ?? undefined,
          onSelect: () => setActing({ action: "revert", commit, checkout: path }),
        },
      );
    }
    const asks: MenuItem[] = [];
    if (onAsk && checkout) {
      const explain = `Explain commit ${commit.sha} in ${checkout.path}: what it changes and why`;
      const review = `Review commit ${commit.sha} in ${checkout.path} for bugs and risks`;
      asks.push(
        { label: "Ask Claude about This Commit", icon: <QueueIcon />, onSelect: () => onAsk(explain) },
        { label: "Ask Claude to Review This Commit", icon: <QueueIcon />, onSelect: () => onAsk(review) },
      );
    }
    return [copies, writes, asks];
  };
  return (
    <aside className="changes" aria-label="Changes">
      <header className="changes-head">
        <span>Changes</span>
      </header>
      {(web || checkout) && (
        <div className="changes-strip">
          {web && (
            <button className="forge-repo" title={`Open ${web.path} on ${forgeName(web)}`} onClick={() => open(web.url)}>
              <bdi>{web.path}</bdi>
              <OpenIcon />
            </button>
          )}
          {checkout && (
            <span className="changes-actions">
              {sync && (
                <>
                  <button
                    title="Open the checkout in VS Code"
                    aria-label="Open in VS Code"
                    onClick={() => controller.act(openFolder(checkout.path, "vs_code"))}
                  >
                    <CodeIcon />
                  </button>
                  <button
                    title="Open the checkout in Finder"
                    aria-label="Open in Finder"
                    onClick={() => controller.act(openFolder(checkout.path, "files"))}
                  >
                    <FolderIcon />
                  </button>
                </>
              )}
              <button title="A new terminal tab in the checkout" aria-label="New terminal tab here" onClick={() => newTab(checkout.path)}>
                <TerminalIcon />
              </button>
              {checkout.origin_url && (
                <button
                  title={`Copy the clone URL: ${checkout.origin_url}`}
                  aria-label="Copy clone URL"
                  onClick={() => copy(checkout.origin_url ?? "")}
                >
                  <CopyIcon />
                </button>
              )}
            </span>
          )}
        </div>
      )}
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
            {checkout.born ? (
              <button
                className="branch branch-toggle"
                aria-expanded={branchesOpen}
                title={branchesOpen ? "Hide the branches" : "Show the local branches"}
                onClick={() => setBranchesOpen(!branchesOpen)}
              >
                {checkout.branch ?? "detached HEAD"}
                <ChevronIcon />
              </button>
            ) : (
              <span className="branch">{checkout.branch ?? "detached HEAD"}</span>
            )}
            {web && pushed && (
              <button className="branch-web" title={`Open ${pushed} on ${forgeName(web)}`} onClick={() => open(treeUrl(web, pushed))}>
                <OpenIcon />
              </button>
            )}
            {checkout.unmerged && checkout.unmerged[1] > 0 && (
              <span className="counts" title={`Commits ${checkout.unmerged[0]} does not have`}>
                {checkout.unmerged[1]} not on {checkout.unmerged[0]}
              </span>
            )}
          </div>
          {branchesOpen && checkout.born && <BranchList checkout={checkout} writable={sync !== null} onWritten={onCommitted} />}
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
          {shownHistory ? (
            <>
              <h3 className="changes-section">
                <span className="history-title" title={shownHistory.path}>
                  History · <bdi>{shownHistory.path.split("/").pop()}</bdi>
                </span>
                <button className="sync-dismiss history-close" aria-label="Back to recent commits" title="Back to recent commits" onClick={() => setHistory(null)}>
                  ×
                </button>
              </h3>
              {shownHistory.error && <p className="empty error">Could not read its history: {shownHistory.error}</p>}
              {!shownHistory.error && !shownHistory.commits && <p className="empty">Reading its history…</p>}
              {shownHistory.commits?.length === 0 && <p className="empty">No commit has changed it.</p>}
              {shownHistory.commits && shownHistory.commits.length > 0 && (
                <CommitList commits={shownHistory.commits} rows={rows("recent")} />
              )}
            </>
          ) : (
            checkout.commits.length > 0 && (
              <>
                <h3 className="changes-section">
                  Recent commits
                  <input
                    type="search"
                    className="commit-filter"
                    placeholder="Filter"
                    aria-label="Filter commits by subject"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setFilter("")}
                  />
                </h3>
                <CommitList
                  commits={filterCommits(checkout.commits, filter)}
                  rows={rows("recent")}
                  checks={head && forgeStatus?.checks ? { sha: head, state: forgeStatus.checks } : undefined}
                />
                {filter.trim() !== "" && filterCommits(checkout.commits, filter).length === 0 && (
                  <p className="empty">No subject among these {checkout.commits.length} matches.</p>
                )}
                {checkout.commits.length >= store.commitLimit(state.phase === "ready" ? state.directory : "") &&
                  checkout.commits.length < MAX_COMMITS && (
                    <button className="load-more" onClick={() => store.loadMore()}>
                      Load more
                    </button>
                  )}
              </>
            )
          )}
          {checkout.stashes.length > 0 && (
            <details className="stashes">
              <summary className="changes-section" title="Listed only: Herdr never applies, pops or drops a stash">
                Stashes · {checkout.stashes.length}
              </summary>
              <ul>
                {checkout.stashes.map((stash) => (
                  <li key={stash.name} title={`${stash.name}: ${stash.message}`}>
                    <span className="stash-message">{stash.message}</span>
                    <span className="when">{relativeTime(stash.time)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Fragment>
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {acting && checkout && acting.checkout === checkout.path && (
        <CommitActionDialog
          key={`${acting.action} ${acting.commit.sha}`}
          action={acting.action}
          checkout={acting.checkout}
          branch={checkout.branch}
          commit={acting.commit}
          onClose={() => setActing(null)}
          onDone={onCommitted}
        />
      )}
    </aside>
  );
}
