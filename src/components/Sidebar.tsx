import { type PointerEvent, useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { Controller } from "../app/controller";
import { copyPath, openFolder } from "../app/folder";
import { workspaceDirectory } from "../changes/counts";
import { agentRefusal, type Land, type LandStore, landing } from "../changes/land";
import { type Queue, workspaceFolder } from "../app/queue";
import { agentsByWorkspace, cardAgents, loopTags, workspaceMarks } from "../app/attention";
import { hasGitLine, shownBranch } from "../app/gitLine";
import { pinKey, pinnedByWorkspace } from "../app/pins";
import { loadOpenCards, saveOpenCards, toggleCard } from "../app/openCards";
import { groupWorktrees, workspaceOn } from "../app/worktreeGroups";
import { dropSlot, loadSort, moveIndex, saveSort, sortWorkspaces, type WorkspaceSort } from "../app/workspaceOrder";
import type { ListeningPort } from "../app/ports";
import type { Worktree } from "../changes/worktrees";
import type { Agent, AgentStatus, Snapshot, Tab, Workspace } from "../protocol";
import { AttentionRows, CardDetails, type LandAction } from "./CardDetails";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { GitAhead, GitBehind, GitChanged } from "./GitCounts";
import { LandDialog, LandNote } from "./Land";
import { LoopMark } from "./LoopMark";
import {
  AttentionOrderIcon,
  BranchIcon,
  ChevronIcon,
  CodeIcon,
  CopyIcon,
  HandOrderIcon,
  OpenIcon,
  PinIcon,
  QueueIcon,
  RenameIcon,
  TeamIcon,
} from "./icons";
import { PortsMark } from "./Ports";
import { QueueChip } from "./QueueChip";
import { RenameField } from "./RenameField";
import { Worktrees } from "./Worktrees";
import { StatusMark } from "./StatusMark";
import { TeamSection } from "./TeamSection";
import { createTeam, type TeamState, useTeams } from "../app/team";

/// What a workspace's right-click offers for its folder, as herdr-gpui's folder menu does.
function folderMenu(controller: Controller, path: string): MenuItem[] {
  return [
    { label: "Open in VS Code", icon: <CodeIcon />, onSelect: () => controller.act(openFolder(path, "vs_code")) },
    {
      label: "Open in GitHub Desktop",
      icon: <BranchIcon />,
      onSelect: () => controller.act(openFolder(path, "github_desktop")),
    },
    { label: "Open Folder", icon: <OpenIcon />, onSelect: () => controller.act(openFolder(path, "files")) },
    { label: "Copy Path", icon: <CopyIcon />, onSelect: () => controller.act(copyPath(path)) },
  ];
}

const NO_LANDS: ReadonlyMap<string, Land> = new Map();
const noLands = () => NO_LANDS;
const noSubscription = () => () => {};

export function Sidebar({
  controller,
  title,
  fullTitle,
  snapshot,
  changedFiles,
  worktrees,
  onOpenWorktrees,
  queues,
  onOpenQueue,
  pins,
  ports,
  rootOf,
  lands,
}: {
  controller: Controller;
  /// The app's name, over the list, and the window's title on hover.
  title: string;
  fullTitle: string;
  snapshot: Snapshot | null;
  /// Files changed in each workspace's checkout, by workspace id; absent when none.
  changedFiles: Map<string, number>;
  /// Linked worktrees of each workspace's checkout, by workspace id; absent when none.
  worktrees: Map<string, Worktree[]>;
  /// Opens the details of a workspace's worktrees.
  onOpenWorktrees: (workspaceId: string) => void;
  /// Each workspace's prompt queue, by workspace id; absent when it has none.
  queues: Map<string, Queue>;
  /// Opens a workspace's prompt queue.
  onOpenQueue: (workspaceId: string) => void;
  /// Pinned tabs, as `pinKey`s.
  pins: Set<string>;
  /// Ports each workspace's servers listen on, by workspace id; absent when none.
  ports: Map<string, ListeningPort[]>;
  /// A workspace's fixed root; null when it has none yet or on a remote host.
  rootOf: (workspace: Workspace) => string | null;
  /// Landing worktrees; `null` on a remote host, whose worktrees are not on this Mac.
  lands: LandStore | null;
}) {
  const landsByRepo = useSyncExternalStore(lands?.subscribe ?? noSubscription, lands?.getState ?? noLands);
  const [sort, setSort] = useState(loadSort);
  // The team file sits in the workspace's own folder, not wherever its active tab has wandered.
  const folderOf = (workspace: Workspace) => (snapshot && (rootOf(workspace) ?? workspaceFolder(workspace, snapshot))) || null;
  const rows = groupWorktrees(
    sortWorkspaces(snapshot?.workspaces ?? [], sort),
    folderOf,
    (workspace) => worktrees.get(workspace.workspace_id) ?? [],
  );
  const workspaces = rows.map((row) => row.workspace);
  // Rows are dragged where they show, but Herdr moves workspaces in its own
  // list, which keeps worktrees wherever they were opened: translate both.
  const drag = useRowDrag(sort === "manual", (from, slot) => {
    const daemon = snapshot?.workspaces ?? [];
    const workspace = workspaces[from];
    const at = (shown: Workspace | undefined) => (shown ? daemon.indexOf(shown) : daemon.length);
    const index = workspace ? moveIndex(at(workspace), at(workspaces[slot])) : null;
    if (workspace && index !== null) {
      controller.request("workspace.move", { workspace_id: workspace.workspace_id, insert_index: index });
    }
  });
  const toggleSort = () => {
    const next: WorkspaceSort = sort === "manual" ? "attention" : "manual";
    setSort(next);
    saveSort(next);
  };
  const agents = snapshot ? agentsByWorkspace(snapshot) : new Map<string, Agent[]>();
  const [openCards, setOpenCards] = useState(loadOpenCards);
  const toggleOpen = (workspaceId: string) => {
    const next = toggleCard(openCards, workspaceId, workspaces.map((workspace) => workspace.workspace_id));
    setOpenCards(next);
    saveOpenCards(next);
  };
  const pinned = pinnedByWorkspace(snapshot?.tabs ?? [], (tab) => pins.has(pinKey(snapshot?.boot_id ?? "", tab.tab_id)));
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [teamVersion, setTeamVersion] = useState(0);
  // New team writes the starter team, then shows it: the workspace takes focus and its file is read again.
  const newTeam = (workspaceId: string, folder: string): MenuItem => ({
    label: "New Team",
    icon: <TeamIcon />,
    onSelect: () => {
      controller.request("workspace.focus", { workspace_id: workspaceId });
      controller.act(createTeam(folder).then(() => setTeamVersion((v) => v + 1)));
    },
  });
  const folders = [...new Set(workspaces.map(folderOf).filter((folder) => folder !== null))].sort();
  const teams = useTeams(folders, teamVersion);
  const teamOf = (workspace: Workspace): TeamState => teams.get(folderOf(workspace) ?? "") ?? { phase: "none" };
  const focused = workspaces.find((workspace) => workspace.focused);
  const focusedFolder = focused && folderOf(focused);
  const asking = [...landsByRepo].find(([, land]) => land.phase === "asking");
  return (
    <nav className="sidebar" aria-label="Workspaces">
      <div className="sidebar-brand" title={fullTitle} data-tauri-drag-region>
        <span data-tauri-drag-region>{title}</span>
      </div>
      <header className="sidebar-head">
        <span>Workspaces</span>
        <button
          className="icon-button sort-toggle"
          title={sort === "manual" ? "Sorted by hand. Click to sort by attention" : "Sorted by attention. Click to sort by hand"}
          aria-label={sort === "manual" ? "Sort by attention" : "Sort by hand"}
          aria-pressed={sort === "attention"}
          onClick={toggleSort}
        >
          {sort === "manual" ? <HandOrderIcon /> : <AttentionOrderIcon />}
        </button>
        <button
          className="icon-button"
          title="New workspace"
          aria-label="New workspace"
          disabled={!snapshot}
          onClick={() => controller.run("new_workspace")}
        >
          +
        </button>
      </header>
      <ol className="workspace-list" ref={drag.list}>
        {rows.map(({ workspace, parent }, index) => {
          const own = agents.get(workspace.workspace_id) ?? [];
          const listed = cardAgents(own);
          const path = snapshot && (rootOf(workspace) ?? workspaceDirectory(workspace, snapshot));
          const marks = workspaceMarks(own, workspace.agent_status);
          const needsYou = marks.some((mark) => mark.status === "blocked");
          const listening = ports.get(workspace.workspace_id) ?? [];
          const trees = worktrees.get(workspace.workspace_id) ?? [];
          const pinnedTabs = pinned.get(workspace.workspace_id) ?? [];
          const queue = queues.get(workspace.workspace_id) ?? null;
          const openQueue = () => onOpenQueue(workspace.workspace_id);
          // A card with nothing more to show has nothing to open.
          const expandable = listed.length + trees.length + listening.length + pinnedTabs.length > 0 || shownBranch(workspace.branch) !== null;
          const open = expandable && openCards.has(workspace.workspace_id);
          const focus = () => {
            if (drag.consumeClick()) return;
            controller.request("workspace.focus", { workspace_id: workspace.workspace_id });
          };
          const openWorktrees = () => onOpenWorktrees(workspace.workspace_id);
          const land: LandAction | null = lands && {
            busy: (worktree) => landing(landsByRepo.get(worktree.repo)),
            // Read when asked, not from this render: it is asked again after a long check.
            start: (worktree) =>
              void lands.ask(workspace.workspace_id, worktree, () =>
                agentRefusal(worktree.path, controller.getState().snapshot),
              ),
          };
          const landed = [...landsByRepo].find(([, land]) => land.card === workspace.workspace_id);
          const gitLine = (
            <WorkspaceGit
              // A collapsed card is one line, so its branch waits in the name's tooltip.
              branch={open ? workspace.branch : null}
              aheadBehind={workspace.git_ahead_behind}
              changed={changedFiles.get(workspace.workspace_id) ?? 0}
              worktrees={trees}
              onOpenWorktrees={openWorktrees}
            />
          );
          // The name line's end: everything that fits beside the name while collapsed.
          const headEnd = (
            <>
              {open ? (
                <PortsMark ports={listening} />
              ) : (
                <>
                  {gitLine}
                  <QueueChip queue={queue} onOpen={openQueue} />
                  <LoopMark tags={loopTags(own)} />
                </>
              )}
              <AgentTally agents={own} marks={marks} />
            </>
          );
          return (
            <li
              key={workspace.workspace_id}
              className={[drag.rowClass(index, workspaces.length), parent && "worktree-child"].filter(Boolean).join(" ") || undefined}
            >
              {/* A worktree hangs off its main checkout's card. */}
              {parent && <span className="worktree-link" aria-hidden="true" />}
              <div
                className={["workspace", workspace.focused && "current", needsYou && "needs-you"].filter(Boolean).join(" ")}
                title={parent ? `A worktree of ${parent.label}` : undefined}
                {...drag.handlers(index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const folder = folderOf(workspace);
                  const rename: MenuItem = {
                    label: "Rename…",
                    icon: <RenameIcon />,
                    onSelect: () => setRenaming(workspace.workspace_id),
                  };
                  const items = [rename];
                  if (path && folder) {
                    const queue: MenuItem = {
                      label: "Add to Queue…",
                      icon: <QueueIcon />,
                      onSelect: () => onOpenQueue(workspace.workspace_id),
                    };
                    items.push(...folderMenu(controller, path), newTeam(workspace.workspace_id, folder), queue);
                  }
                  setMenu({ x: event.clientX, y: event.clientY, items });
                }}
              >
                {/* While its name is edited the card is a plain box: a field cannot sit in a button. */}
                {renaming === workspace.workspace_id ? (
                  <div className="workspace-main">
                    <span className="workspace-head">
                      <RenameField
                        className="workspace-rename"
                        label="Workspace name"
                        initial={workspace.label}
                        onDone={(label) => {
                          setRenaming(null);
                          controller.focusTerminal();
                          if (label !== null && label !== workspace.label)
                            controller.request("workspace.rename", { workspace_id: workspace.workspace_id, label });
                        }}
                      />
                      {headEnd}
                    </span>
                    {open && gitLine}
                  </div>
                ) : (
                  <button
                    className="workspace-main"
                    aria-current={workspace.focused ? "true" : undefined}
                    onClick={focus}
                    onDoubleClick={() => setRenaming(workspace.workspace_id)}
                  >
                    <span className="workspace-head">
                      <span className="workspace-label" title={[path, shownBranch(workspace.branch)].filter(Boolean).join("\n") || undefined}>
                        {workspace.label}
                      </span>
                      {headEnd}
                    </span>
                    {open && gitLine}
                  </button>
                )}
                {/* Beside the card's button, not in it, as is everything below:
                    a row can be a button of its own. */}
                {expandable && (
                  <button
                    className="workspace-chevron"
                    title={open ? "Hide details" : "Show details"}
                    aria-label={`${open ? "Hide" : "Show"} details of ${workspace.label}`}
                    aria-expanded={open}
                    onClick={() => toggleOpen(workspace.workspace_id)}
                  >
                    <ChevronIcon />
                  </button>
                )}
                {snapshot &&
                  (open ? (
                    <>
                      <div className="workspace-tray" onClick={focus}>
                        <QueueChip queue={queue} onOpen={openQueue} />
                        <PinnedTabs tabs={pinnedTabs} />
                        <LoopMark tags={loopTags(own)} />
                      </div>
                      <CardDetails
                        controller={controller}
                        snapshot={snapshot}
                        agents={listed}
                        worktrees={trees}
                        ports={listening}
                        openOn={(worktree) => workspaceOn(worktree, workspaces, folderOf)}
                        onOpenWorktrees={openWorktrees}
                        land={land}
                      />
                    </>
                  ) : (
                    <AttentionRows
                      controller={controller}
                      snapshot={snapshot}
                      agents={own}
                      onExpand={() => toggleOpen(workspace.workspace_id)}
                    />
                  ))}
                {landed && <LandNote land={landed[1]} onDismiss={() => lands?.dismiss(landed[0])} />}
              </div>
            </li>
          );
        })}
      </ol>
      {snapshot && workspaces.length === 0 && <p className="empty">No workspaces. Press + to open one.</p>}
      {snapshot && focused && focusedFolder && (
        <TeamSection
          controller={controller}
          snapshot={snapshot}
          workspace={focused}
          directory={focusedFolder}
          team={teamOf(focused)}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      {asking?.[1].phase === "asking" && (
        <LandDialog
          plan={asking[1].plan}
          path={asking[1].worktree.path}
          openIn={workspaceOn(asking[1].worktree, workspaces, folderOf)?.label ?? null}
          onCancel={() => lands?.cancel(asking[0])}
          onConfirm={() => void lands?.confirm(asking[0])}
        />
      )}
    </nav>
  );
}

/// Pointer travel before a press on a row becomes a drag rather than a click.
const DRAG_THRESHOLD = 4;

/// Dragging rows of a list into a new order, by pointer rather than HTML drag
/// and drop, which Tauri's file-drop handling swallows. While it runs, the
/// dragged row dims and a line marks the gap it would land in; releasing
/// calls `onDrop` with the row's index and that gap, 0 to the row count.
function useRowDrag(enabled: boolean, onDrop: (from: number, slot: number) => void) {
  const list = useRef<HTMLOListElement>(null);
  const press = useRef<{ from: number; startY: number; active: boolean } | null>(null);
  const dragged = useRef(false);
  const [state, setState] = useState<{ from: number; slot: number } | null>(null);

  const slotAt = (y: number) =>
    dropSlot(y, [...(list.current?.children ?? [])].map((row) => row.getBoundingClientRect()));

  const end = () => {
    press.current = null;
    setState(null);
    document.body.classList.remove("reordering");
  };

  return {
    list,
    rowClass(index: number, count: number): string | undefined {
      if (!state) return undefined;
      const classes = [];
      if (index === state.from) classes.push("row-dragged");
      if (state.slot === index) classes.push("drop-before");
      if (state.slot === count && index === count - 1) classes.push("drop-after");
      return classes.join(" ") || undefined;
    },
    handlers: (index: number) =>
      enabled
        ? {
            onPointerDown(event: PointerEvent<HTMLElement>) {
              if (event.button !== 0) return;
              press.current = { from: index, startY: event.clientY, active: false };
            },
            onPointerMove(event: PointerEvent<HTMLElement>) {
              const current = press.current;
              if (!current) return;
              if (!current.active) {
                if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return;
                current.active = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                document.body.classList.add("reordering");
              }
              setState({ from: current.from, slot: slotAt(event.clientY) });
            },
            onPointerUp(event: PointerEvent<HTMLElement>) {
              const current = press.current;
              if (current?.active) {
                dragged.current = true;
                onDrop(current.from, slotAt(event.clientY));
              }
              end();
            },
            onLostPointerCapture: end,
          }
        : {},
    /// True once after a drag, so the click its release fires does not focus the row.
    consumeClick(): boolean {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
  };
}

/// Its agents by status, beside the name: the badge for those waiting on you,
/// then each other live status's mark with how many when more than one.
/// Hovering gives the whole count.
function AgentTally({ agents, marks }: { agents: Agent[]; marks: { status: AgentStatus; count: number }[] }) {
  const shown = marks.filter(({ status }) => status !== "unknown");
  if (shown.length === 0) return null;
  const label = agents.length > 0 ? `${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : undefined;
  return (
    <span className="agent-tally" title={label}>
      {shown.map(({ status, count }) =>
        status === "blocked" ? (
          <StatusMark key={status} status={status} count={count} />
        ) : (
          <span key={status} className="tally">
            <StatusMark status={status} />
            {count > 1 && count}
          </span>
        ),
      )}
    </span>
  );
}

/// A pin when the workspace has pinned tabs, with their count when more than
/// one; hovering names them.
function PinnedTabs({ tabs }: { tabs: Tab[] }) {
  if (tabs.length === 0) return null;
  const label = `Pinned: ${tabs.map((tab) => tab.label).join(", ")}`;
  return (
    <span className="pinned-tabs" title={label} aria-label={label}>
      <PinIcon />
      {tabs.length > 1 && tabs.length}
    </span>
  );
}

/// The Git facts, as herdr-gpui's folder card has them: the branch unless it is
/// `main` or `master`, commits to push and pull, how many files are changed, and
/// how many linked worktrees the checkout has. Only what is non-zero shows, and
/// they are gone when that leaves nothing. A `null` branch leaves the name out.
function WorkspaceGit({
  branch,
  aheadBehind,
  changed,
  worktrees,
  onOpenWorktrees,
}: {
  branch: string | null;
  aheadBehind: [number, number] | null;
  changed: number;
  worktrees: Worktree[];
  onOpenWorktrees: () => void;
}) {
  const [ahead, behind] = aheadBehind ?? [0, 0];
  if (!hasGitLine(branch, [ahead, behind, changed, worktrees.length])) return null;
  const name = shownBranch(branch);
  return (
    <span className="workspace-branch">
      {name && <span className="workspace-branch-name">{name}</span>}
      <GitAhead count={ahead} />
      <GitBehind count={behind} />
      <GitChanged count={changed} />
      <Worktrees worktrees={worktrees} onOpen={onOpenWorktrees} />
    </span>
  );
}
