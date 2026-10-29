import { getCurrentWindow } from "@tauri-apps/api/window";
import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { attentionCount } from "./app/attention";
import { hueColor } from "./app/hue";
import { loadPins } from "./app/pins";
import { type ClaudeUsage, readClaudeUsage } from "./app/claudeUsage";
import { type ListeningPort, readPorts, samePorts } from "./app/ports";
import { clampWidth, loadWidth, saveWidth } from "./app/sidebar";
import { Controller } from "./app/controller";
import { countedDirectories, readCounts } from "./changes/counts";
import { readWorktrees, type Worktree } from "./changes/worktrees";
import { ChangesStore, type RecentCommit } from "./changes/store";
import { useCommitFiles } from "./changes/useCommitFiles";
import { ChangesPanel, type DiffPick } from "./components/ChangesPanel";
import { CommitDiffView } from "./components/CommitDiffView";
import { DiffView } from "./components/DiffView";
import { FilesPanel } from "./components/FilesPanel";
import { FileView } from "./components/FileView";
import { HostKeyDialog } from "./components/HostKeyDialog";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { WorktreesDialog } from "./components/WorktreesDialog";
import { Terminal } from "./components/Terminal";
import { useListing } from "./files/listing";
import type { Snapshot } from "./protocol";

/// How often an open Changes panel rereads its checkout.
const CHANGES_POLL_MS = 5000;
/// How often the sidebar recounts every workspace's changed files.
const COUNTS_POLL_MS = 10000;
/// How often listening ports are rescanned: servers start and stop at human
/// pace, and `lsof` is not free on a busy machine.
const PORTS_POLL_MS = 5000;
/// How often Claude usage is asked for and its countdowns redrawn; the
/// backend reads Anthropic at most every ten minutes whatever this is.
const USAGE_POLL_MS = 60_000;

/// The directory the focused pane's program is in.
function focusedDirectory(snapshot: Snapshot | null): string | null {
  const pane = snapshot?.panes.find((p) => p.pane_id === snapshot.focused_pane_id);
  return pane?.foreground_cwd ?? pane?.cwd ?? null;
}

export default function App() {
  const controller = useMemo(() => new Controller(), []);
  const changesStore = useMemo(() => new ChangesStore(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const changes = useSyncExternalStore(changesStore.subscribe, changesStore.getState);
  const [diffPick, setDiffPick] = useState<DiffPick | null>(null);
  const [openCommit, setOpenCommit] = useState<RecentCommit | null>(null);
  const [filePick, setFilePick] = useState<string | null>(null);
  // The workspace whose worktrees the details dialog shows.
  const [worktreesOf, setWorktreesOf] = useState<string | null>(null);
  // Kept here, not in the tab bar, so the sidebar can mark workspaces with pinned tabs.
  const [pins, setPins] = useState(loadPins);
  const directory = focusedDirectory(state.snapshot);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampWidth(loadWidth(), window.innerWidth));
  const commitSidebarWidth = (width: number) => {
    setSidebarWidth(width);
    saveWidth(width);
  };

  // A narrower window shrinks the sidebar for now, without forgetting the saved width.
  useEffect(() => {
    const onResize = () => setSidebarWidth(clampWidth(loadWidth(), window.innerWidth));
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
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  // Agents that finished or wait on you badge the Dock and lead the title,
  // following the daemon's statuses rather than whether the window is in front.
  const attention = attentionCount(state.snapshot);
  useEffect(() => {
    const title = state.title ? `${state.title} — Herdr` : "Herdr";
    document.title = attention > 0 ? `(${attention}) ${title}` : title;
  }, [state.title, attention]);

  useEffect(() => {
    getCurrentWindow()
      .setBadgeCount(attention > 0 ? attention : undefined)
      .catch(() => {});
  }, [attention]);

  // Every workspace's changed-file count, one `git status` per folder, and
  // its checkout's linked worktrees, never two rounds at once. Reread on a
  // timer and when the window comes back.
  const counted = useMemo(
    () => (state.snapshot ? countedDirectories(state.snapshot) : { byWorkspace: new Map<string, string>(), directories: [] }),
    [state.snapshot],
  );
  const directoriesKey = counted.directories.join("\0");
  const [counts, setCounts] = useState<Map<string, number | null>>(new Map());
  const [worktreeLists, setWorktreeLists] = useState<Map<string, Worktree[] | null>>(new Map());
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
  }, [directoriesKey]);
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

  // Every workspace's listening ports, scanned on this Mac only: a remote
  // host's servers are not reachable at its localhost from here.
  const local = state.status.phase === "connected" && state.host === null;
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

  const focusedPorts = ports.get(state.snapshot?.focused_workspace_id ?? "") ?? [];
  const focusedWorkspace = state.snapshot?.workspaces.find((w) => w.workspace_id === state.snapshot?.focused_workspace_id);

  // An open panel follows the focused pane, rereads on a timer, and rereads
  // when the window comes back, since work usually happened elsewhere. The
  // Files panel reads it too, to mark the changed files in its tree.
  const readChanges = state.changes || state.files;
  useEffect(() => {
    if (!readChanges || !directory) return;
    const refresh = () => changesStore.refresh(directory);
    refresh();
    const timer = window.setInterval(refresh, CHANGES_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [readChanges, directory, changesStore]);

  const checkout = changes.phase === "ready" ? changes.checkout : null;
  const checkoutPath = checkout?.path ?? null;
  // A commit opened in one checkout means nothing in the next.
  useEffect(() => setOpenCommit(null), [checkoutPath]);
  const commitFiles = useCommitFiles(checkoutPath, openCommit?.sha ?? null);

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
  // A file opened in one checkout means nothing in the next.
  useEffect(() => setFilePick(null), [listingRoot]);
  const changedMarks = useMemo(
    () => new Map(checkout?.path === listingRoot ? checkout.files.map((f) => [f.path, f.mark]) : []),
    [checkout, listingRoot],
  );
  const shownTreeFile = state.files && listingRoot && filePick;
  const closeFile = () => {
    setFilePick(null);
    controller.focusTerminal();
  };

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

  const paletteCommands = useMemo(
    // `focus_tab_3` and friends are shortcuts, not things anyone searches for.
    () => state.commands.filter((command) => !/_\d$/.test(command.name)),
    [state.commands],
  );

  return (
    <div
      className={`app ${state.sidebar ? "" : "no-sidebar"}`}
      style={{ gridTemplateColumns: state.sidebar ? `${sidebarWidth}px 1fr` : undefined }}
    >
      {state.sidebar && <Sidebar controller={controller} snapshot={state.snapshot} changedFiles={changedFiles} worktrees={worktrees} onOpenWorktrees={setWorktreesOf} pins={pins} ports={ports} />}
      {state.sidebar && (
        <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={commitSidebarWidth} />
      )}
      <div className="workarea">
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
              changes={state.changes}
              files={state.files}
              pins={pins}
              onPinsChange={setPins}
            />
            <div className="stage">
              <Terminal controller={controller} fontSize={state.fontSize} />
            </div>
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
            {shownTreeFile && <FileView root={listingRoot} path={filePick} onClose={closeFile} />}
          </div>
          <StatusBar controller={controller} state={state} workspace={focusedWorkspace?.label} worktrees={worktrees.get(focusedWorkspace?.workspace_id ?? "") ?? []} onOpenWorktrees={() => setWorktreesOf(focusedWorkspace?.workspace_id ?? null)} ports={focusedPorts} usage={usage.usage} now={usage.now} />
        </main>
        <div className={`drawer ${readChanges ? "open" : ""}`} aria-hidden={!readChanges}>
          {state.files ? (
            <FilesPanel
              state={listing}
              changed={changedMarks}
              selected={shownTreeFile ? filePick : null}
              onOpen={setFilePick}
              onLeave={() => controller.focusTerminal()}
              onClose={() => {
                controller.closeFiles();
                closeFile();
              }}
            />
          ) : (
            <ChangesPanel
              store={changesStore}
              selected={shownDiff ? diffPick : null}
              openCommit={openCommit?.sha ?? null}
              commitFiles={commitFiles}
              onOpen={setDiffPick}
              onToggleCommit={toggleCommit}
              onClose={() => {
                controller.closeChanges();
                closeDiff();
              }}
            />
          )}
        </div>
      </div>
      {state.palette && <Palette controller={controller} commands={paletteCommands} />}
      {shownWorktrees && (
        <WorktreesDialog
          controller={controller}
          workspaceId={shownWorktrees.workspace.workspace_id}
          workspace={shownWorktrees.workspace.label}
          worktrees={shownWorktrees.list}
          onClose={closeWorktrees}
        />
      )}
      {state.hostKey && <HostKeyDialog controller={controller} hostKey={state.hostKey} />}
    </div>
  );
}
