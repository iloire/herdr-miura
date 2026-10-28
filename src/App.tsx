import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { attentionCount } from "./app/attention";
import { clampWidth, loadWidth, saveWidth } from "./app/sidebar";
import { Controller } from "./app/controller";
import { countedDirectories, readCounts } from "./changes/counts";
import { ChangesStore, type ChangedFile } from "./changes/store";
import { ChangesPanel } from "./components/ChangesPanel";
import { DiffView } from "./components/DiffView";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { Terminal } from "./components/Terminal";
import type { Snapshot } from "./protocol";

/// How often an open Changes panel rereads its checkout.
const CHANGES_POLL_MS = 5000;
/// How often the sidebar recounts every workspace's changed files.
const COUNTS_POLL_MS = 10000;

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
  const [diffFile, setDiffFile] = useState<ChangedFile | null>(null);
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
    controller.loadCatalog().catch(() => {});
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

  // Every workspace's changed-file count, one `git status` per folder, never
  // two rounds at once. Reread on a timer and when the window comes back.
  const counted = useMemo(
    () => (state.snapshot ? countedDirectories(state.snapshot) : { byWorkspace: new Map<string, string>(), directories: [] }),
    [state.snapshot],
  );
  const directoriesKey = counted.directories.join("\0");
  const [counts, setCounts] = useState<Map<string, number | null>>(new Map());
  useEffect(() => {
    const directories = directoriesKey ? directoriesKey.split("\0") : [];
    if (directories.length === 0) return;
    let reading = false;
    let live = true;
    const refresh = () => {
      if (reading) return;
      reading = true;
      readCounts(directories)
        .then((next) => live && setCounts(next))
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

  // An open panel follows the focused pane, rereads on a timer, and rereads
  // when the window comes back, since work usually happened elsewhere.
  useEffect(() => {
    if (!state.changes || !directory) return;
    const refresh = () => changesStore.refresh(directory);
    refresh();
    const timer = window.setInterval(refresh, CHANGES_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [state.changes, directory, changesStore]);

  const checkout = changes.phase === "ready" ? changes.checkout : null;
  // A diff stays open only while its file is still listed in the checkout.
  const shownDiff = state.changes && checkout && diffFile && checkout.files.find((f) => f.path === diffFile.path);

  const closeDiff = () => {
    setDiffFile(null);
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
      {state.sidebar && <Sidebar controller={controller} snapshot={state.snapshot} changedFiles={changedFiles} />}
      {state.sidebar && (
        <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={commitSidebarWidth} />
      )}
      <div className="workarea">
        <main className="main">
          <TabBar controller={controller} snapshot={state.snapshot} changes={state.changes} />
          <div className="stage">
            <Terminal controller={controller} fontSize={state.fontSize} />
            {shownDiff && checkout && (
              <DiffView
                checkout={checkout.path}
                files={checkout.files}
                file={shownDiff}
                onSelect={setDiffFile}
                onClose={closeDiff}
              />
            )}
          </div>
          <StatusBar controller={controller} state={state} />
        </main>
        <div className={`drawer ${state.changes ? "open" : ""}`} aria-hidden={!state.changes}>
          <ChangesPanel
            store={changesStore}
            selected={shownDiff ? shownDiff.path : null}
            onOpen={setDiffFile}
            onClose={() => {
              controller.closeChanges();
              closeDiff();
            }}
          />
        </div>
      </div>
      {state.palette && <Palette controller={controller} commands={paletteCommands} />}
    </div>
  );
}
