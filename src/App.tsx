import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { attentionCount } from "./app/attention";
import { tabGit } from "./app/gitLine";
import { type HueSlot, workspaceHue, workspaceSlots } from "./app/hue";
import { loadLayout, type SavedFile, saveLayout } from "./app/layout";
import { loadPins } from "./app/pins";
import { loadTabColors, saveTabColors, withoutClosedTabs } from "./app/tabColors";
import { type ClaudeUsage, readClaudeUsage } from "./app/claudeUsage";
import { type ListeningPort, readPorts, samePorts } from "./app/ports";
import { sessionFolders } from "./app/recentSessions";
import { readSessionUsage, type SessionUsage, sessionOf } from "./app/sessionUsage";
import { DRAWER, SIDEBAR, clampDrawer, clampSidebar, loadWidth, saveWidth } from "./app/paneWidth";
import { busyQueues, isActive, itemOfTab, type Queue, queueDirectory, queueKey, workspaceFolder } from "./app/queue";
import { useQueue } from "./app/useQueue";
import { useLedger } from "./app/useLedger";
import { useTodoistLinks } from "./app/useTodoistLinks";
import { offers, taskOfPanes } from "./app/todoistLinks";
import { useTodoistTasks } from "./app/useTodoistTasks";
import { dueBy, localDay } from "./app/todoist";
import { allParked, asksForYou, doneToday, isOpen, type Outcome, parkedFor, parkedPrompt, waitingClosed } from "./app/ledger";
import { fontStack, saveWorkspaceColor, saveWorkspaceGroup } from "./app/settings";
import { useHome } from "./app/useHome";
import { useSettings } from "./app/useSettings";
import { useRestoreSessions } from "./app/useRestoreSessions";
import { useRoots } from "./app/useRoots";
import { useSeen } from "./app/useSeen";
import { inLinkedWorktree, paneDirectory, sharedCheckout, tabDirectory, withSessionFolders } from "./app/sharedCheckout";
import { strayPath } from "./app/workspaceRoot";
import { groupWorktrees } from "./app/worktreeGroups";
import { Controller } from "./app/controller";
import { countedDirectories, readCounts } from "./changes/counts";
import { readWorktrees, type Worktree } from "./changes/worktrees";
import { ChangesStore, type ChangedFile, type CheckoutChanges, type FoundCommit, type RecentCommit } from "./changes/store";
import { fileAfter } from "./changes/discard";
import { agentRefusal, LandStore } from "./changes/land";
import { ForgeStore } from "./changes/forge";
import { SyncStore } from "./changes/sync";
import { commitBeside } from "./changes/commit";
import { useCommitFiles } from "./changes/useCommitFiles";
import { ChangesPanel } from "./components/ChangesPanel";
import { CommitDiffView } from "./components/CommitDiffView";
import { DEV_BRANCH } from "./components/DevBar";
import { DiffView } from "./components/DiffView";
import { DiscardDialog } from "./components/Discard";
import { FilesPanel } from "./components/FilesPanel";
import { FileView } from "./components/FileView";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { PromptPalette } from "./components/PromptPalette";
import type { QueueOwner } from "./components/AllQueues";
import { QueuePanel } from "./components/QueuePanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { TodoistPanel } from "./components/TodoistPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { SettingsWarnings } from "./components/SettingsWarnings";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { PaneResizer } from "./components/PaneResizer";
import { PanelSwitch } from "./components/PanelSwitch";
import { TabHeader } from "./components/TabHeader";
import { UsageDialog } from "./components/UsageDialog";
import { DayDialog } from "./components/DayDialog";
import { ContextDialog } from "./components/ContextDialog";
import { WorktreesDialog } from "./components/WorktreesDialog";
import { Terminal } from "./components/Terminal";
import { type FoundFile, loadShowIgnored, saveShowIgnored, useListing } from "./files/listing";
import type { Snapshot } from "./protocol";
import { fieldPassesChord } from "./terminal/keys";

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

/// Text fields ⌥↑/↓ does not leave: a workspace switch would land behind an open
/// dialog, or throw away the edit of a queued prompt.
const KEEPS_ARROWS = ".palette-backdrop, .queue-edit";

/// A file opened from a pane's text, and the folder of that pane.
type LinkedFile = FoundFile & { from: string };

/// The directory the focused pane's program is in.
function focusedDirectory(snapshot: Snapshot | null): string | null {
  const pane = snapshot?.panes.find((p) => p.pane_id === snapshot.focused_pane_id);
  return paneDirectory(pane);
}

export default function App() {
  const controller = useMemo(() => new Controller(), []);
  const changesStore = useMemo(() => new ChangesStore(), []);
  const forgeStore = useMemo(() => new ForgeStore(), []);
  // A fetch or push may bring a pull request or a CI run, so GitHub is asked again.
  const syncStore = useMemo(
    () =>
      new SyncStore((checkout, op) => {
        changesStore.reread();
        if (op !== "pull") forgeStore.stale(checkout);
      }),
    [changesStore, forgeStore],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const changes = useSyncExternalStore(changesStore.subscribe, changesStore.getState);
  const settings = useSettings(controller);
  const [diffFile, setDiffFile] = useState<ChangedFile | null>(null);
  // The file the discard dialog is open on.
  const [discarding, setDiscarding] = useState<ChangedFile | null>(null);
  const [openCommit, setOpenCommit] = useState<RecentCommit | null>(null);
  const [filePick, setFilePick] = useState<string | null>(null);
  // The workspace whose worktrees the details dialog shows.
  const [worktreesOf, setWorktreesOf] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [dayOpen, setDayOpen] = useState(false);
  const [contextOf, setContextOf] = useState<string | null>(null);
  // Kept here, not in the tab bar, so the sidebar can mark workspaces with pinned tabs.
  const [pins, setPins] = useState(loadPins);
  const [tabColors, setTabColors] = useState<ReadonlyMap<string, HueSlot>>(loadTabColors);
  // The files picked in the drawer when the window last closed, reopened once
  // their checkout is read, and until then kept from being saved over.
  const restore = useRef<{ changesFile: SavedFile | null; treeFile: SavedFile | null } | null>(null);
  restore.current ??= loadLayout();
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
      // Option alone stays with a text field, but for ⌥↑/↓, which leave it unless
      // that would hide what is in it or break an IME composition. A rename never
      // gets here: RenameField stops its keys.
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable)) {
        const keepsArrows = event.isComposing || target.closest(KEEPS_ARROWS) !== null;
        if (!fieldPassesChord(event, keepsArrows)) return;
      }
      if (controller.shortcut(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    // The macOS app menu's items, which also own their keys there.
    const menuItems = ["open_settings", "reopen_closed_session"].map((command) =>
      listen(`menu://${command}`, () => controller.run(command)),
    );
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      for (const unlisten of menuItems) void unlisten.then((stop) => stop());
    };
  }, [controller]);

  // Agents that finished or wait on you badge the Dock and lead the title,
  // following the daemon's statuses rather than whether the window is in front.
  const { shown: seenAs, markSeen } = useSeen(state.snapshot, state.host);
  const attention = attentionCount(seenAs);
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
  const { roots, rootOf, queueFolderOf, moves, isOpenSplitOf, markSplit } = useRoots(state.snapshot, local);
  useRestoreSessions(state.snapshot, local, controller);
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
  // A land or a discard just ended, so the worktrees and counts are stale now, not in 10 s.
  const [writesEnded, setWritesEnded] = useState(0);
  const landStore = useMemo(() => new LandStore(() => setWritesEnded((ended) => ended + 1)), []);
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
  }, [directoriesKey, writesEnded]);
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

  // The colors chosen for workspaces. Every place that shows a workspace's hue
  // reads it through `workspaceHue` with these.
  const colors = state.settings.workspaceColors;
  const slots = useMemo(() => {
    const snapshot = state.snapshot;
    if (!snapshot) return new Map<string, HueSlot>();
    const rows = groupWorktrees(
      snapshot.workspaces,
      (workspace) => rootOf(workspace) ?? workspaceFolder(workspace, snapshot),
      (workspace) => worktrees.get(workspace.workspace_id) ?? [],
    );
    return workspaceSlots(rows, rootOf, colors);
  }, [state.snapshot, rootOf, worktrees, colors]);
  // A closed tab's color goes with it, in case its id comes back on a new tab.
  // The daemon's list, not `state.snapshot`: a tab whose close is on its way
  // is hidden from that one, and comes back if the close is refused.
  useEffect(() => {
    const bootId = state.snapshot?.boot_id;
    if (!bootId) return;
    const open = withoutClosedTabs(tabColors, bootId, controller.listedTabs());
    if (open === tabColors) return;
    setTabColors(open);
    saveTabColors(open, bootId);
  }, [controller, state.snapshot, tabColors]);
  const chooseColor = (key: string, slot: HueSlot | null) =>
    controller.act(saveWorkspaceColor(key, slot).then(settings.reload));
  const moveColor = (from: string, to: string, slot: HueSlot) =>
    controller.act(saveWorkspaceColor(to, slot).then(() => saveWorkspaceColor(from, null)).then(settings.reload));
  // Sidebar groups: each entry puts a workspace in a group, or `null` out of one.
  const setGroups = (entries: [string, string | null][]) =>
    controller.act(
      entries.reduce((done, [key, name]) => done.then(() => saveWorkspaceGroup(key, name)), Promise.resolve()).then(settings.reload),
    );

  // Every outcome agents reported, kept past their panes (docs/plan-inbox.md).
  const ledger = useLedger(controller);
  // Which Todoist task each outcome's prompt came from (docs/plan-todoist.md).
  const todoist = useTodoistLinks(controller, ledger.list, local);
  // The tasks the Todoist panel lists and the status bar counts.
  const todoistTasks = useTodoistTasks(state.settings.todoistFilter, state.todoist);
  const todoistChip = {
    due: todoistTasks.off || !todoistTasks.read ? null : dueBy(todoistTasks.read.tasks, localDay()),
    filter: state.settings.todoistFilter,
    onOpen: () => controller.openTodoist(),
  };
  // Each main checkout's prompt queue, run one prompt at a time on this Mac.
  const { file: queueFile, access: queueAccess, actions: queueActions } = useQueue(controller, state.snapshot, local, queueFolderOf, rootOf, isOpenSplitOf, moves);
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
  // The open workspaces a Todoist task can go to, by the repo folder on disk.
  const todoistTargets = useMemo(() => {
    const snapshot = state.snapshot;
    if (!snapshot || !local) return [];
    return snapshot.workspaces.flatMap((workspace) => {
      const queueFolder = queueFolderOf(workspace);
      return queueFolder
        ? [{ workspaceId: workspace.workspace_id, label: workspace.label, folder: queueDirectory(queueFolder), queueFolder }]
        : [];
    });
  }, [state.snapshot, local, queueFolderOf]);
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

  // Where each pane's program really is: Claude Code enters a worktree without
  // its process moving, so everything that reads a checkout goes by this.
  const located = useMemo(
    () => state.snapshot && withSessionFolders(state.snapshot, sessionUsages),
    [state.snapshot, sessionUsages],
  );
  const directory = focusedDirectory(located);
  const linkedWorktrees = useMemo(
    () => [...worktreeLists.values()].flatMap((list) => list ?? []).map((worktree) => worktree.path),
    [worktreeLists],
  );
  const worktreeTabs = useMemo(() => {
    if (!located) return new Set<string>();
    const inWorktree = located.tabs.filter((tab) => {
      const folder = tabDirectory(tab, located);
      return folder !== null && inLinkedWorktree(folder, linkedWorktrees);
    });
    return new Set(inWorktree.map((tab) => tab.tab_id));
  }, [located, linkedWorktrees]);

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
  const shared = useMemo(() => {
    if (!local || !located) return null;
    return sharedCheckout(located, changes, directory, linkedWorktrees);
  }, [local, located, changes, directory, linkedWorktrees]);
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
  // A commit linked from a pane waits here for the panel to read its checkout.
  // Opened any sooner, the change of checkout above would close it again.
  const [linkedCommit, setLinkedCommit] = useState<FoundCommit | null>(null);
  useEffect(() => {
    if (!linkedCommit || linkedCommit.checkout !== checkoutPath) return;
    setLinkedCommit(null);
    setDiffFile(null);
    setOpenCommit(linkedCommit.commit);
  }, [linkedCommit, checkoutPath]);
  const commitFiles = useCommitFiles(checkoutPath, openCommit?.sha ?? null);

  // The first checkout read reopens the diff left open in it, if the file is
  // still changed; a commit's diff is not kept.
  useEffect(() => {
    const saved = restore.current?.changesFile;
    if (!saved || !checkout) return;
    const file = saved.root === checkout.path ? checkout.files.find((f) => f.path === saved.path) : undefined;
    if (file) setDiffFile(file);
    restore.current = { ...restore.current!, changesFile: null };
  }, [checkout]);
  useEffect(() => {
    if (restore.current?.changesFile) return;
    const changesFile = checkoutPath && diffFile ? { root: checkoutPath, path: diffFile.path } : null;
    saveLayout({ changesFile });
  }, [checkoutPath, diffFile]);

  // A file's diff stays open only while the checkout still lists the file.
  const shownFile = state.changes && diffFile ? checkout?.files.find((f) => f.path === diffFile.path) : undefined;
  const shownCommit = state.changes && checkout ? openCommit : null;

  const closeDiff = () => {
    setDiffFile(null);
    setOpenCommit(null);
    controller.focusTerminal();
  };

  // A diff's line number: a click copies its URL on the web, ⌘-click opens it.
  const lineLink = useMemo(
    () => (url: string, open: boolean) => controller.act(open ? openUrl(url) : writeText(url)),
    [controller],
  );

  const checkoutWritten = () => {
    changesStore.reread();
    setWritesEnded((ended) => ended + 1);
  };

  const closeDiscard = () => {
    setDiscarding(null);
    if (!shownFile) controller.focusTerminal();
  };

  // A discard of the file on show moves on to the next, or closes after the last.
  const discarded = (file: ChangedFile) => {
    checkoutWritten();
    setDiscarding(null);
    if (shownFile?.path !== file.path) return closeDiscard();
    const next = checkout ? fileAfter(checkout.files, file.path) : null;
    if (next) setDiffFile(next);
    else closeDiff();
  };

  const openFile = (file: ChangedFile) => {
    setOpenCommit(null);
    setDiffFile(file);
  };

  // Picking a commit opens it; picking it again closes it.
  const toggleCommit = (commit: RecentCommit) => {
    if (openCommit?.sha === commit.sha) return closeDiff();
    setDiffFile(null);
    setOpenCommit(commit);
  };

  const listedCommits = useRef<RecentCommit[]>([]);
  const stepCommit = (by: number) => {
    const next = openCommit && commitBeside(listedCommits.current, openCommit.sha, by);
    if (next) setOpenCommit(next);
  };

  // A file linked from a pane may sit in another checkout, a worktree say, so
  // the Files panel lists that one until the file closes or the pane moves on.
  const [linkedFile, setLinkedFile] = useState<LinkedFile | null>(null);
  const linked = linkedFile?.from === directory ? linkedFile : null;
  const [showIgnored, setShowIgnored] = useState(loadShowIgnored);
  useEffect(() => saveShowIgnored(showIgnored), [showIgnored]);
  const listing = useListing(linked?.root ?? directory, state.files, showIgnored);
  const listingRoot = listing.phase === "ready" ? (listing.listing?.root ?? null) : null;
  // A file opened in one checkout means nothing in the next, except the one
  // left open when the window last closed.
  useEffect(() => {
    const saved = restore.current?.treeFile;
    setFilePick(saved && saved.root === listingRoot ? saved.path : null);
    if (saved && listingRoot) restore.current = { ...restore.current!, treeFile: null };
  }, [listingRoot]);
  // After the effect above, which clears the pick when the checkout changes.
  useEffect(() => {
    if (linked && linked.root === listingRoot) setFilePick(linked.path);
  }, [linked, listingRoot]);
  // Closing the panel closes its file, and a linked one must not come back.
  useEffect(() => {
    if (!state.files) setLinkedFile(null);
  }, [state.files]);
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
    setLinkedFile(null);
    controller.focusTerminal();
  };
  const viewShown = useRef(false);
  viewShown.current = Boolean(shownFile || shownCommit || shownTreeFile);
  // Going to a tab shows it, even the one already focused under the diff.
  useEffect(() => {
    controller.viewOpen = () => viewShown.current;
    controller.closeViews = () => {
      setDiffFile(null);
      setOpenCommit(null);
      setFilePick(null);
      setLinkedFile(null);
    };
    controller.showCommit = setLinkedCommit;
    controller.showFile = (found, from) => setLinkedFile({ ...found, from });
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
  const focusedParked = useMemo(
    () => (local && queueFolder ? parkedFor(ledger.list, queueDirectory(queueFolder)) : []),
    [local, queueFolder, ledger.list],
  );
  const allQueues = useMemo(() => (local && queueFile ? busyQueues(queueFile) : []), [local, queueFile]);
  const queueOwner = (folder: string): QueueOwner | null => {
    const owner = state.snapshot?.workspaces.find((w) => queueFolderOf(w) === folder);
    return owner ? { workspaceId: owner.workspace_id, label: owner.label, hue: workspaceHue(owner, slots) } : null;
  };
  const onParked = (outcome: Outcome, how: "queued" | "dismissed" | "todo") => {
    if (how === "queued") {
      if (!queueFolder || !queueActions) return;
      queueActions.add(queueFolder, parkedPrompt(outcome), false);
    }
    ledger.resolve(outcome.id, how);
  };
  // Which tab holds each live Claude session, for the ledger's rows; only this
  // computer's snapshot can hold the sessions its ledger names.
  const liveSessions = useMemo(() => {
    const tabs = new Map<string, string>();
    if (!local) return tabs;
    for (const agent of state.snapshot?.agents ?? []) {
      const session = sessionOf(agent);
      if (session) tabs.set(session, agent.tab_id);
    }
    return tabs;
  }, [local, state.snapshot]);
  useEffect(() => {
    controller.needsYouCleared = (sessions) => {
      const closing = new Set(sessions);
      for (const outcome of ledger.list) {
        if (asksForYou(outcome.kind) && isOpen(outcome) && closing.has(outcome.session)) ledger.resolve(outcome.id, "cleared");
      }
    };
  }, [controller, ledger]);
  // Only this computer's snapshot can say which of its sessions are closed.
  const closedOutcomes = useMemo(
    () => (local ? waitingClosed(ledger.list, new Set(liveSessions.keys())) : []),
    [local, ledger.list, liveSessions],
  );
  const ledgerCounts = {
    done: doneToday(ledger.list, usage.now).length,
    parked: allParked(ledger.list).length,
    waiting: closedOutcomes.length,
    todoist: offers(ledger.list, todoist.linked, usage.now).length,
  };
  const closedAsks = {
    outcomes: closedOutcomes,
    onResume: (outcome: Outcome) => resumeOutcome(outcome),
    onClear: (outcome: Outcome) => ledger.resolve(outcome.id, "cleared"),
  };
  // A closed session resumes in a workspace on its repo, else the focused one.
  const resumeOutcome = (outcome: Outcome) => {
    const workspace = state.snapshot?.workspaces.find((w) => queueFolderOf(w) === outcome.home) ?? focusedWorkspace;
    if (!local || !workspace) return controller.act(Promise.reject("Resuming a session works on this computer's workspaces only"));
    setDayOpen(false);
    controller.resumeSession(workspace.workspace_id, outcome.session);
  };
  const queueBusy = Boolean(focusedQueue?.items.some((item) => item.state === "queued" || isActive(item)));
  useEffect(() => controller.followQueue(queueBusy), [controller, queueBusy, focusedWorkspace?.workspace_id]);
  // The chip on a card focuses that workspace too, so the panel shows its queue.
  const openQueue = (workspaceId: string) => {
    controller.request("workspace.focus", { workspace_id: workspaceId });
    controller.openQueue();
  };
  // The Todoist task the focused tab's latest prompt came from.
  const tabTask = useMemo(() => {
    const snapshot = state.snapshot;
    if (!local || !snapshot?.focused_tab_id) return null;
    const panes = snapshot.panes.filter((pane) => pane.tab_id === snapshot.focused_tab_id).map((pane) => pane.pane_id);
    return taskOfPanes(todoist.links, panes);
  }, [local, state.snapshot, todoist.links]);
  const queuedTab = local && state.snapshot?.focused_tab_id ? itemOfTab(queueFile, state.snapshot.focused_tab_id) : null;

  // The folders whose Claude sessions are this workspace's: on this Mac only.
  const focusedRoot = focusedWorkspace && state.snapshot ? (rootOf(focusedWorkspace) ?? workspaceFolder(focusedWorkspace, state.snapshot)) : null;
  const focusedWorktrees = worktrees.get(focusedWorkspace?.workspace_id ?? "");
  const recentFolders = useMemo(
    () => (local ? sessionFolders(focusedRoot, focusedWorktrees ?? []) : null),
    [local, focusedRoot, focusedWorktrees],
  );
  const focusedWorkspaceId = local ? (focusedWorkspace?.workspace_id ?? null) : null;
  useEffect(() => {
    controller.reopenSession = () => controller.reopenClosed(focusedWorkspaceId, recentFolders);
  }, [controller, focusedWorkspaceId, recentFolders]);

  const drawerOpen = readChanges || state.queue || state.sessions || state.todoist;

  return (
    <>
      <div
        className={`app ${state.sidebar ? "" : "no-sidebar"}`}
        style={{ gridTemplateColumns: state.sidebar ? `${sidebarWidth}px 1fr` : undefined }}
      >
        {state.sidebar && <Sidebar controller={controller} title={app} fullTitle={windowTitle} snapshot={seenAs} changedFiles={changedFiles} worktrees={worktrees} onOpenWorktrees={setWorktreesOf} queues={queues} onOpenQueue={openQueue} pins={pins} ports={ports} rootOf={rootOf} lands={local ? landStore : null} onMarkSeen={markSeen} slots={slots} onChooseColor={chooseColor} onMoveColor={moveColor} groups={state.settings.workspaceGroups} onSetGroups={setGroups} cards={state.settings.workspaceCards} showAgents={state.settings.ui.sidebarAgents} findAsked={state.findWorkspace} switchViewAsked={state.switchSidebarView} closedAsks={closedAsks} />}
        {state.sidebar && (
          <PaneResizer pane={SIDEBAR} width={sidebarWidth} clamp={fitSidebar} onChange={setWantedSidebar} onCommit={commitSidebarWidth} />
        )}
        <div className="workarea">
          <PanelSwitch
            controller={controller}
            changes={state.changes}
            changed={changedFiles.get(focusedWorkspace?.workspace_id ?? "") ?? 0}
            files={state.files}
            queue={state.queue}
            queued={{
              waiting: focusedQueue?.items.filter((item) => item.state === "queued").length ?? 0,
              running: Boolean(focusedQueue?.items.some(isActive)),
            }}
            sessions={state.sessions}
            todoist={state.todoist}
            showSessions={local}
          />
          {/* The focused workspace's hue marks the selected tab and the status
              bar, so the main column reads as the card picked in the sidebar. */}
          <main
            className="main"
            style={focusedWorkspace ? ({ "--hue": workspaceHue(focusedWorkspace, slots) } as CSSProperties) : undefined}
          >
            {/* The diff covers the tab bar too: its tabs are the sessions, not
                the diff's, and would read as if they switched what it shows. */}
            <div className="deck">
              <TabBar
                controller={controller}
                snapshot={seenAs}
                worktreeTabs={worktreeTabs}
                pins={pins}
                onPinsChange={setPins}
                tabColors={tabColors}
                onTabColorsChange={setTabColors}
                wrap={state.settings.tabsWrap}
                newTabCommand={state.settings.newTabCommand}
                onMarkSeen={markSeen}
                onOpenQueue={openQueue}
                onSplit={markSplit}
              />
              <TabHeader controller={controller} snapshot={seenAs} library={state.library} usages={sessionUsages} plan={usage.usage} git={git} shared={shared} stray={stray} ports={focusedPorts} queued={queuedTab} task={tabTask} onOpenContext={setContextOf} />
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
                  onSelect={setDiffFile}
                  onClose={closeDiff}
                  onDiscard={local ? () => setDiscarding(shownFile) : null}
                  covered={discarding !== null}
                  web={checkout.web}
                  head={checkout.commits[0]?.sha ?? null}
                  onLineLink={lineLink}
                />
              )}
              {shownCommit && checkout && (
                <CommitDiffView
                  checkout={checkout.path}
                  commit={shownCommit}
                  state={commitFiles}
                  web={checkout.web}
                  onLineLink={lineLink}
                  onStep={stepCommit}
                  onClose={closeDiff}
                />
              )}
              {shownTreeFile && <FileView root={listingRoot} path={filePick} readOnly={!local} onOpen={setFilePick} onClose={closeFile} onSaved={checkoutWritten} />}
            </div>
            <StatusBar controller={controller} state={state} workspace={focusedWorkspace?.label} worktrees={worktrees.get(focusedWorkspace?.workspace_id ?? "") ?? []} onOpenWorktrees={() => setWorktreesOf(focusedWorkspace?.workspace_id ?? null)} queue={focusedQueue} onOpenQueue={() => controller.openQueue()} ports={focusedPorts} usage={usage.usage} now={usage.now} onOpenUsage={() => setUsageOpen(true)} ledger={ledgerCounts} onOpenDay={() => setDayOpen(true)} todoist={todoistChip} />
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
                hue={focusedWorkspace ? workspaceHue(focusedWorkspace, slots) : ""}
                folder={local ? queueFolder : null}
                queue={focusedQueue}
                access={queueAccess}
                actions={local ? queueActions : null}
                parked={focusedParked}
                onParked={onParked}
                todoist={todoistTasks.off ? null : state.settings.todoistProjects}
                all={allQueues}
                ownerOf={queueOwner}
              />
            ) : state.sessions && state.snapshot ? (
              <SessionsPanel
                controller={controller}
                snapshot={state.snapshot}
                workspace={focusedWorkspace ?? null}
                hue={focusedWorkspace ? workspaceHue(focusedWorkspace, slots) : ""}
                folders={recentFolders}
                resuming={state.resuming}
              />
            ) : state.todoist && state.snapshot ? (
              <TodoistPanel
                controller={controller}
                snapshot={state.snapshot}
                workspace={focusedWorkspace ?? null}
                hue={focusedWorkspace ? workspaceHue(focusedWorkspace, slots) : ""}
                filter={state.settings.todoistFilter}
                tasks={todoistTasks}
                projects={state.settings.todoistProjects}
                home={home}
                targets={todoistTargets}
                folder={local && queueFolder ? queueDirectory(queueFolder) : null}
                queueFolder={local ? queueFolder : null}
                queue={local && queueAccess.kind === "ready" ? queueActions : null}
              />
            ) : state.files ? (
              <FilesPanel
                controller={controller}
                state={listing}
                changed={changedMarks}
                selected={shownTreeFile ? filePick : null}
                onOpen={setFilePick}
                onLeave={() => controller.focusTerminal()}
                showIgnored={showIgnored}
                onToggleIgnored={() => setShowIgnored((show) => !show)}
              />
            ) : (
              <ChangesPanel
                controller={controller}
                store={changesStore}
                sync={local ? syncStore : null}
                forge={local ? forgeStore : null}
                onAsk={
                  local && queueFolder && queueAccess.kind === "ready"
                    ? (prompt) => {
                        queueActions.add(queueFolder, prompt, false);
                        controller.openQueue();
                      }
                    : null
                }
                selected={shownFile ?? null}
                openCommit={openCommit?.sha ?? null}
                listedCommits={listedCommits}
                onOpen={openFile}
                onToggleCommit={toggleCommit}
                onDiscard={setDiscarding}
                onCommitted={checkoutWritten}
              />
            )}
          </div>
        </div>
        {discarding && checkout && local && (
          <DiscardDialog
            key={discarding.path}
            checkout={checkout.path}
            branch={checkout.branch}
            file={discarding}
            agent={agentRefusal(checkout.path, state.snapshot, "checkout")}
            onClose={closeDiscard}
            onDiscarded={discarded}
          />
        )}
        {state.library && (
          <PromptPalette
            controller={controller}
            snapshot={state.snapshot}
            folder={local && queueFolder ? queueDirectory(queueFolder) : null}
            queueFolder={local ? queueFolder : null}
            queue={local && queueAccess.kind === "ready" ? queueActions : null}
          />
        )}
        {shownWorktrees && (
          <WorktreesDialog
            controller={controller}
            workspaceId={shownWorktrees.workspace.workspace_id}
            workspace={shownWorktrees.workspace.label}
            hue={workspaceHue(shownWorktrees.workspace, slots)}
            worktrees={shownWorktrees.list}
            onClose={closeWorktrees}
          />
        )}
        {usageOpen && (
          <UsageDialog
            usage={usage.usage}
            now={usage.now}
            snapshot={state.snapshot}
            sessions={sessionUsages}
            onOpenContext={(session) => {
              setUsageOpen(false);
              setContextOf(session);
            }}
            onClose={() => {
              setUsageOpen(false);
              controller.focusTerminal();
            }}
          />
        )}
        {dayOpen && (
          <DayDialog
            list={ledger.list}
            now={Date.now()}
            live={liveSessions}
            onGo={(tabId) => {
              setDayOpen(false);
              controller.request("tab.focus", { tab_id: tabId });
            }}
            onResume={resumeOutcome}
            onQueue={
              local && queueActions
                ? (outcome) => {
                    queueActions.add(outcome.home, parkedPrompt(outcome), false);
                    ledger.resolve(outcome.id, "queued");
                  }
                : null
            }
            onResolve={(outcome, how) => ledger.resolve(outcome.id, how)}
            linked={todoist.linked}
            onTodoist={(outcome) =>
              controller.act(todoist.write(outcome).then(() => outcome.kind === "left" && ledger.resolve(outcome.id, "todo")))
            }
            onClose={() => {
              setDayOpen(false);
              controller.focusTerminal();
            }}
          />
        )}
        {contextOf && (
          <ContextDialog
            snapshot={state.snapshot}
            focus={contextOf}
            onClose={() => {
              setContextOf(null);
              controller.focusTerminal();
            }}
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
