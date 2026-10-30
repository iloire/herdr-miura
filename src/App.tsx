import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { attentionCount } from "./app/attention";
import { tabGit } from "./app/gitLine";
import { hueColor } from "./app/hue";
import { loadLayout, type SavedFile, saveLayout } from "./app/layout";
import { loadPins } from "./app/pins";
import { type ClaudeUsage, readClaudeUsage } from "./app/claudeUsage";
import { type ListeningPort, readPorts, samePorts } from "./app/ports";
import { readSessionUsage, type SessionUsage, sessionOf } from "./app/sessionUsage";
import { DRAWER, SIDEBAR, clampDrawer, clampSidebar, loadWidth, saveWidth } from "./app/paneWidth";
import { isActive, itemOfTab, type Queue, queueKey } from "./app/queue";
import { useQueue } from "./app/useQueue";
import { fontStack } from "./app/settings";
import { useHome } from "./app/useHome";
import { useSettings } from "./app/useSettings";
import { useRoots } from "./app/useRoots";
import { strayPath } from "./app/workspaceRoot";
import { Controller } from "./app/controller";
import { countedDirectories, readCounts } from "./changes/counts";
import { readWorktrees, type Worktree } from "./changes/worktrees";
import { ChangesStore, type CheckoutChanges, type RecentCommit } from "./changes/store";
import { LandStore } from "./changes/land";
import { SyncStore } from "./changes/sync";
import { useCommitFiles } from "./changes/useCommitFiles";
import { ChangesPanel, type DiffPick } from "./components/ChangesPanel";
import { CommitDiffView } from "./components/CommitDiffView";
import { DEV_BRANCH } from "./components/DevBar";
import { DiffView } from "./components/DiffView";
import { FilesPanel } from "./components/FilesPanel";
import { FileView } from "./components/FileView";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { Palette } from "./components/Palette";
import { PromptPalette } from "./components/PromptPalette";
import { QueuePanel } from "./components/QueuePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { SettingsWarnings } from "./components/SettingsWarnings";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { PaneResizer } from "./components/PaneResizer";
import { PanelSwitch } from "./components/PanelSwitch";
import { TabHeader } from "./components/TabHeader";
import { WorktreesDialog } from "./components/WorktreesDialog";
import { Terminal } from "./components/Terminal";
import { useListing } from "./files/listing";
import type { Snapshot } from "./protocol";

/// How often an open Changes panel rereads its checkout.
const CHANGES_POLL_MS = 5000;
/// How often an open Changes panel fetches, so ↓ means something.
const FETCH_POLL_MS = 180_000;
/// How often the tab header's Git facts are reread while no panel is.
const TAB_GIT_POLL_MS = 15_000;
/// How often the sidebar recounts every workspace's changed files.
const COUNTS_POLL_MS = 10000;
/// How often listening ports are rescanned: servers start and stop at human
/// pace, and `lsof` is not free on a busy machine.
const PORTS_POLL_MS = 5000;
/// How often Claude usage is asked for and its countdowns redrawn; the
/// backend reads Anthropic at most every ten minutes whatever this is.
const USAGE_POLL_MS = 60_000;
/// How often each Claude session's transcript is reread for the tab header;
/// only what was appended since is read.
const SESSIONS_POLL_MS = 15_000;

/// The directory the focused pane's program is in.
function focusedDirectory(snapshot: Snapshot | null): string | null {
  const pane = snapshot?.panes.find((p) => p.pane_id === snapshot.focused_pane_id);
  return pane?.foreground_cwd ?? pane?.cwd ?? null;
}

export default function App() {
  const controller = useMemo(() => new Controller(), []);
  const changesStore = useMemo(() => new ChangesStore(), []);
  const syncStore = useMemo(() => new SyncStore(() => changesStore.reread()), [changesStore]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const changes = useSyncExternalStore(changesStore.subscribe, changesStore.getState);
  const settings = useSettings(controller);
  const [diffPick, setDiffPick] = useState<DiffPick | null>(null);
  const [openCommit, setOpenCommit] = useState<RecentCommit | null>(null);
  const [filePick, setFilePick] = useState<string | null>(null);
  // The workspace whose worktrees the details dialog shows.
  const [worktreesOf, setWorktreesOf] = useState<string | null>(null);
  // Kept here, not in the tab bar, so the sidebar can mark workspaces with pinned tabs.
  const [pins, setPins] = useState(loadPins);
  // The files picked in the drawer when the window last closed, reopened once
  // their checkout is read, and until then kept from being saved over.
  const restore = useRef<{ changesFile: SavedFile | null; treeFile: SavedFile | null } | null>(null);
  restore.current ??= loadLayout();
  const directory = focusedDirectory(state.snapshot);
  // The widths asked for, which a narrower window or a wider sidebar shrink
  // only as they are shown, so neither forgets the saved width.
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [wantedSidebar, setWantedSidebar] = useState(() => loadWidth(SIDEBAR));
  const [wantedDrawer, setWantedDrawer] = useState(() => loadWidth(DRAWER));
  const fitSidebar = (width: number) => clampSidebar(width, windowWidth);
  const sidebarWidth = fitSidebar(wantedSidebar);
  const fitDrawer = (width: number) => clampDrawer(width, windowWidth, state.sidebar ? sidebarWidth : 0);
  const drawerWidth = fitDrawer(wantedDrawer);
  const commitSidebarWidth = (width: number) => {
    setWantedSidebar(width);
    saveWidth(SIDEBAR, width);
  };
  const commitDrawerWidth = (width: number) => {
    setWantedDrawer(width);
    saveWidth(DRAWER, width);
  };

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    controller.loadCatalog();
    controller.loadHosts();
    // Shortcuts work wherever focus is, not only in the terminal.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey || event.altKey)) return;
      // Option alone moves by word in a text field, such as a rename.
      const field = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (field && !(event.metaKey || event.ctrlKey)) return;
      if (controller.shortcut(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    // The macOS app menu's Settings… item, which also owns ⌘, there.
    const unlisten = listen("menu://open_settings", () => controller.run("open_settings"));
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      void unlisten.then((stop) => stop());
    };
  }, [controller]);

  // Agents that finished or wait on you badge the Dock and lead the title,
  // following the daemon's statuses rather than whether the window is in front.
  const attention = attentionCount(state.snapshot);
  const app = DEV_BRANCH ? `Herdr [${DEV_BRANCH}]` : "Herdr";
  const titled = state.title ? `${state.title} — ${app}` : app;
  const windowTitle = attention > 0 ? `(${attention}) ${titled}` : titled;
  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  useEffect(() => {
    getCurrentWindow()
      .setBadgeCount(attention > 0 ? attention : undefined)
      .catch(() => {});
  }, [attention]);

  const local = state.status.phase === "connected" && state.host === null;
  const { roots, rootOf, queueFolderOf } = useRoots(state.snapshot, local);
  // Every workspace's changed-file count, one `git status` per folder, and
  // its checkout's linked worktrees, never two rounds at once. A workspace
  // with a fixed root reads that, not its active tab's folder. Reread on a
  // timer and when the window comes back.
  const counted = useMemo(
    () => (state.snapshot ? countedDirectories(state.snapshot, rootOf) : { byWorkspace: new Map<string, string>(), directories: [] }),
    [state.snapshot, rootOf],
  );
  const directoriesKey = counted.directories.join("\0");
  const [counts, setCounts] = useState<Map<string, number | null>>(new Map());
  const [worktreeLists, setWorktreeLists] = useState<Map<string, Worktree[] | null>>(new Map());
  // A land just ended, so the worktrees and counts are stale now, not in 10 s.
  const [landsEnded, setLandsEnded] = useState(0);
  const landStore = useMemo(() => new LandStore(() => setLandsEnded((ended) => ended + 1)), []);
  useEffect(() => {
    const directories = directoriesKey ? directoriesKey.split("\0") : [];
    if (directories.length === 0) return;
    let reading = false;
    let live = true;
    const refresh = () => {
      if (reading) return;
      reading = true;
      Promise.all([
        readCounts(directories).then((next) => live && setCounts(next)),
        readWorktrees(directories).then((next) => live && setWorktreeLists(next)),
      ])
        .catch(() => {})
        .finally(() => (reading = false));
    };
    refresh();
    const timer = window.setInterval(refresh, COUNTS_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [directoriesKey, landsEnded]);
  const changedFiles = useMemo(() => {
    const byWorkspace = new Map<string, number>();
    for (const [workspace, directory] of counted.byWorkspace) {
      const count = counts.get(directory);
      if (count) byWorkspace.set(workspace, count);
    }
    return byWorkspace;
  }, [counted, counts]);
  const worktrees = useMemo(() => {
    const byWorkspace = new Map<string, Worktree[]>();
    for (const [workspace, directory] of counted.byWorkspace) {
      const list = worktreeLists.get(directory);
      if (list?.length) byWorkspace.set(workspace, list);
    }
    return byWorkspace;
  }, [counted, worktreeLists]);

  // Each main checkout's prompt queue, run one prompt at a time on this Mac.
  const { file: queueFile, access: queueAccess, actions: queueActions } = useQueue(controller, state.snapshot, local, queueFolderOf, rootOf);
  const queues = useMemo(() => {
    const byWorkspace = new Map<string, Queue>();
    const snapshot = state.snapshot;
    if (!snapshot || !local) return byWorkspace;
    for (const workspace of snapshot.workspaces) {
      const folder = queueFolderOf(workspace);
      const queue = folder ? queueFile?.queues[queueKey(folder)] : undefined;
      if (queue) byWorkspace.set(workspace.workspace_id, queue);
    }
    return byWorkspace;
  }, [state.snapshot, local, queueFile, queueFolderOf]);
  // Every workspace's listening ports, scanned on this Mac only: a remote
  // host's servers are not reachable at its localhost from here.
  const [ports, setPorts] = useState<Map<string, ListeningPort[]>>(new Map());
  useEffect(() => {
    if (!local) {
      setPorts(new Map());
      return;
    }
    let scanning = false;
    let live = true;
    const refresh = () => {
      if (scanning) return;
      scanning = true;
      readPorts()
        .then((next) => live && setPorts((previous) => (samePorts(previous, next) ? previous : next)))
        .catch(() => {})
        .finally(() => (scanning = false));
    };
    refresh();
    const timer = window.setInterval(refresh, PORTS_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [local]);
  // Claude plan usage is this Mac's account, so it is read whichever host
  // the window is connected to.
  const [usage, setUsage] = useState<{ usage: ClaudeUsage | null; now: number }>({ usage: null, now: Date.now() });
  useEffect(() => {
    let live = true;
    const refresh = () => {
      readClaudeUsage()
        .then((next) => live && setUsage({ usage: next, now: Date.now() }))
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, USAGE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // Each Claude session's token use, from its transcript on this Mac.
  const sessions = useMemo(
    () => [...new Set(state.snapshot?.agents.map(sessionOf).filter((id) => id !== null))].sort(),
    [state.snapshot],
  );
  const sessionKey = sessions.join("\n");
  const [sessionUsages, setSessionUsages] = useState<Map<string, SessionUsage | null>>(new Map());
  useEffect(() => {
    const ids = sessionKey ? sessionKey.split("\n") : [];
    if (!local || ids.length === 0) {
      setSessionUsages(new Map());
      return;
    }
    let reading = false;
    let live = true;
    const refresh = () => {
      if (reading) return;
      reading = true;
      readSessionUsage(ids)
        .then((next) => live && setSessionUsages(next))
        .catch(() => {})
        .finally(() => (reading = false));
    };
    refresh();
    const timer = window.setInterval(refresh, SESSIONS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [local, sessionKey]);

  const focusedPorts = ports.get(state.snapshot?.focused_workspace_id ?? "") ?? [];
  const focusedWorkspace = state.snapshot?.workspaces.find((w) => w.workspace_id === state.snapshot?.focused_workspace_id);

  // An open panel follows the focused pane, rereads on a timer, and rereads
  // when the window comes back, since work usually happened elsewhere. The
  // Files panel reads it too, to mark the changed files in its tree. With both
  // closed the tab header keeps it going, slower and on this Mac only: a
  // remote host's folders are refused.
  const readChanges = state.changes || state.files;
  const changesPoll = readChanges ? CHANGES_POLL_MS : local ? TAB_GIT_POLL_MS : null;
  useEffect(() => {
    if (changesPoll === null || !directory) return;
    const refresh = () => changesStore.refresh(directory);
    refresh();
    const timer = window.setInterval(refresh, changesPoll);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [changesPoll, directory, changesStore]);
  const git = local ? tabGit(changes, directory) : null;
  const home = useHome();
  const stray = local ? strayPath(changes, directory, roots.folders[focusedWorkspace?.workspace_id ?? ""] ?? null, home) : null;

  // The panels go by the read they last saw. The tab header's reads with both
  // closed must not close the open commit, spend the diff waiting to reopen on
  // whichever checkout happens to be focused, or save over it.
  const panelCheckout = useRef<CheckoutChanges | null>(null);
  if (readChanges) panelCheckout.current = changes.phase === "ready" ? changes.checkout : null;
  const checkout = panelCheckout.current;
  const checkoutPath = checkout?.path ?? null;
  // An open Changes panel fetches on this Mac, on a timer and when the window
  // comes back, since `git status` alone only knows the last fetch.
  const fetched = state.changes && local && checkout?.remotes.length ? checkoutPath : null;
  useEffect(() => {
    if (!fetched) return;
    const fetch = () => syncStore.fetch(fetched);
    fetch();
    const timer = window.setInterval(fetch, FETCH_POLL_MS);
    window.addEventListener("focus", fetch);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", fetch);
    };
  }, [fetched, syncStore]);
  // A commit opened in one checkout means nothing in the next.
  useEffect(() => setOpenCommit(null), [checkoutPath]);
  const commitFiles = useCommitFiles(checkoutPath, openCommit?.sha ?? null);

  // The first checkout read reopens the diff left open in it, if the file is
  // still changed; a commit's diff is not kept.
  useEffect(() => {
    const saved = restore.current?.changesFile;
    if (!saved || !checkout) return;
    const file = saved.root === checkout.path ? checkout.files.find((f) => f.path === saved.path) : undefined;
    if (file) setDiffPick({ file, commit: null });
    restore.current = { ...restore.current!, changesFile: null };
  }, [checkout]);
  useEffect(() => {
    if (restore.current?.changesFile) return;
    const changesFile = checkoutPath && diffPick?.commit === null ? { root: checkoutPath, path: diffPick.file.path } : null;
    saveLayout({ changesFile });
  }, [checkoutPath, diffPick]);

  // A diff stays open only while what it shows is still listed: the file in
  // the checkout, or the commit still open in the panel.
  const diffCommit = diffPick?.commit && diffPick.commit === openCommit?.sha ? openCommit : null;
  const shownFile =
    state.changes && diffPick?.commit === null ? checkout?.files.find((f) => f.path === diffPick.file.path) : undefined;
  const shownCommit = state.changes && checkout ? diffCommit : null;
  const shownDiff = Boolean(shownFile || shownCommit);

  const closeDiff = () => {
    setDiffPick(null);
    controller.focusTerminal();
  };

  // Picking a commit opens its diff; picking it again closes both.
  const toggleCommit = (commit: RecentCommit) => {
    if (openCommit?.sha === commit.sha) {
      setOpenCommit(null);
      if (diffPick?.commit === commit.sha) closeDiff();
    } else {
      setOpenCommit(commit);
      setDiffPick({ file: null, commit: commit.sha });
    }
  };

  const listing = useListing(directory, state.files);
  const listingRoot = listing.phase === "ready" ? (listing.listing?.root ?? null) : null;
  // A file opened in one checkout means nothing in the next, except the one
  // left open when the window last closed.
  useEffect(() => {
    const saved = restore.current?.treeFile;
    setFilePick(saved && saved.root === listingRoot ? saved.path : null);
    if (saved && listingRoot) restore.current = { ...restore.current!, treeFile: null };
  }, [listingRoot]);
  useEffect(() => {
    if (restore.current?.treeFile) return;
    saveLayout({ treeFile: listingRoot && filePick ? { root: listingRoot, path: filePick } : null });
  }, [listingRoot, filePick]);
  const changedMarks = useMemo(
    () => new Map(checkout?.path === listingRoot ? checkout.files.map((f) => [f.path, f.mark]) : []),
    [checkout, listingRoot],
  );
  const shownTreeFile = state.files && listingRoot && filePick;
  const closeFile = () => {
    setFilePick(null);
    controller.focusTerminal();
  };
  // Going to a tab shows it, even the one already focused under the diff.
  useEffect(() => {
    controller.closeViews = () => {
      setDiffPick(null);
      setFilePick(null);
    };
  }, [controller]);

  // The dialog closes on its own once the workspace is gone or its last
  // worktree is removed.
  const worktreesWorkspace = state.snapshot?.workspaces.find((w) => w.workspace_id === worktreesOf);
  const worktreesList = worktreesOf ? worktrees.get(worktreesOf) : undefined;
  const shownWorktrees =
    worktreesWorkspace && worktreesList ? { workspace: worktreesWorkspace, list: worktreesList } : null;
  const closeWorktrees = () => {
    setWorktreesOf(null);
    controller.focusTerminal();
  };

  // The Queue panel shows the focused workspace's queue, and opens on its own
  // when that workspace has prompts queued or running.
  const queueFolder = focusedWorkspace ? queueFolderOf(focusedWorkspace) : null;
  const focusedQueue = queues.get(focusedWorkspace?.workspace_id ?? "") ?? null;
  const queueBusy = Boolean(focusedQueue?.items.some((item) => item.state === "queued" || isActive(item)));
  useEffect(() => controller.followQueue(queueBusy), [controller, queueBusy, focusedWorkspace?.workspace_id]);
  // The chip on a card focuses that workspace too, so the panel shows its queue.
  const openQueue = (workspaceId: string) => {
    controller.request("workspace.focus", { workspace_id: workspaceId });
    controller.openQueue();
  };
  const queuedTab = local && state.snapshot?.focused_tab_id ? itemOfTab(queueFile, state.snapshot.focused_tab_id) : null;

  const paletteCommands = useMemo(
    // `focus_tab_3` and friends are shortcuts, not things anyone searches for.
    () => state.commands.filter((command) => !/_\d$/.test(command.name)),
    [state.commands],
  );

  const drawerOpen = readChanges || state.queue;

  return (
    <>
      <div
        className={`app ${state.sidebar ? "" : "no-sidebar"}`}
        style={{ gridTemplateColumns: state.sidebar ? `${sidebarWidth}px 1fr` : undefined }}
      >
        {state.sidebar && <Sidebar controller={controller} title={app} fullTitle={windowTitle} snapshot={state.snapshot} changedFiles={changedFiles} worktrees={worktrees} onOpenWorktrees={setWorktreesOf} queues={queues} onOpenQueue={openQueue} pins={pins} ports={ports} rootOf={rootOf} lands={local ? landStore : null} />}
        {state.sidebar && (
          <PaneResizer pane={SIDEBAR} width={sidebarWidth} clamp={fitSidebar} onChange={setWantedSidebar} onCommit={commitSidebarWidth} />
        )}
        <div className="workarea">
          <PanelSwitch
            controller={controller}
            changes={state.changes}
            files={state.files}
            queue={state.queue}
            queued={{
              waiting: focusedQueue?.items.filter((item) => item.state === "queued").length ?? 0,
              running: Boolean(focusedQueue?.items.some(isActive)),
            }}
          />
          {/* The focused workspace's hue marks the selected tab and the status
              bar, so the main column reads as the card picked in the sidebar. */}
          <main
            className="main"
            style={focusedWorkspace ? ({ "--hue": hueColor(focusedWorkspace.label) } as CSSProperties) : undefined}
          >
            {/* The diff covers the tab bar too: its tabs are the sessions, not
                the diff's, and would read as if they switched what it shows. */}
            <div className="deck">
              <TabBar
                controller={controller}
                snapshot={state.snapshot}
                pins={pins}
                onPinsChange={setPins}
                wrap={state.settings.tabsWrap}
              />
              <TabHeader controller={controller} snapshot={state.snapshot} library={state.library} usages={sessionUsages} plan={usage.usage} git={git} stray={stray} ports={focusedPorts} queued={queuedTab} />
              <div className="stage">
                <Terminal
                  controller={controller}
                  fontSize={state.fontSize}
                  fontFamily={fontStack(state.settings.terminal.fontFamily)}
                  lineHeight={state.settings.terminal.lineHeight}
                  theme={state.theme.terminal}
                />
              </div>
              {/* The dialog lists them itself. */}
              {!state.settingsOpen && <SettingsWarnings view={settings} />}
              {shownFile && checkout && (
                <DiffView
                  checkout={checkout.path}
                  files={checkout.files}
                  file={shownFile}
                  onSelect={(file) => setDiffPick({ file, commit: null })}
                  onClose={closeDiff}
                />
              )}
              {shownCommit && checkout && (
                <CommitDiffView
                  checkout={checkout.path}
                  commit={shownCommit}
                  state={commitFiles}
                  focus={diffPick?.file ?? null}
                  onClose={closeDiff}
                />
              )}
              {shownTreeFile && <FileView root={listingRoot} path={filePick} onOpen={setFilePick} onClose={closeFile} />}
            </div>
            <StatusBar controller={controller} state={state} workspace={focusedWorkspace?.label} worktrees={worktrees.get(focusedWorkspace?.workspace_id ?? "") ?? []} onOpenWorktrees={() => setWorktreesOf(focusedWorkspace?.workspace_id ?? null)} queue={focusedQueue} onOpenQueue={() => controller.openQueue()} ports={focusedPorts} usage={usage.usage} now={usage.now} />
          </main>
          {drawerOpen && (
            <PaneResizer pane={DRAWER} width={drawerWidth} clamp={fitDrawer} onChange={setWantedDrawer} onCommit={commitDrawerWidth} />
          )}
          <div
            className={`drawer ${drawerOpen ? "open" : ""}`}
            aria-hidden={!drawerOpen}
            style={{ "--drawer-width": `${drawerWidth}px` } as CSSProperties}
          >
            {state.queue && state.snapshot ? (
              <QueuePanel
                controller={controller}
                snapshot={state.snapshot}
                workspace={focusedWorkspace ?? null}
                folder={local ? queueFolder : null}
                queue={focusedQueue}
                access={queueAccess}
                actions={local ? queueActions : null}
                focusComposer={!state.queueAuto}
              />
            ) : state.files ? (
              <FilesPanel
                state={listing}
                changed={changedMarks}
                selected={shownTreeFile ? filePick : null}
                onOpen={setFilePick}
                onLeave={() => controller.focusTerminal()}
              />
            ) : (
              <ChangesPanel
                store={changesStore}
                sync={local ? syncStore : null}
                selected={shownDiff ? diffPick : null}
                openCommit={openCommit?.sha ?? null}
                commitFiles={commitFiles}
                onOpen={setDiffPick}
                onToggleCommit={toggleCommit}
              />
            )}
          </div>
        </div>
        {state.palette && <Palette controller={controller} commands={paletteCommands} />}
        {state.library && (
          <PromptPalette
            controller={controller}
            snapshot={state.snapshot}
            folder={local ? queueFolder : null}
            queue={local && queueAccess.kind === "ready" ? queueActions : null}
          />
        )}
        {shownWorktrees && (
          <WorktreesDialog
            controller={controller}
            workspaceId={shownWorktrees.workspace.workspace_id}
            workspace={shownWorktrees.workspace.label}
            worktrees={shownWorktrees.list}
            onClose={closeWorktrees}
          />
        )}
        {state.settingsOpen && (
          <SettingsDialog
            controller={controller}
            settings={state.settings}
            view={settings}
            onClose={() => {
              controller.run("open_settings");
              controller.focusTerminal();
            }}
          />
        )}
        {state.hostKey && <HostKeyDialog controller={controller} hostKey={state.hostKey} />}
      </div>
    </>
  );
}
