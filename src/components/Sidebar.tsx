import { type CSSProperties, type PointerEvent, useCallback, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { copyPath, openFolder } from "../app/folder";
import { workspaceDirectory } from "../changes/counts";
import { type Queue, workspaceFolder } from "../app/queue";
import { agentsByWorkspace, loopTags, workspaceMarks } from "../app/attention";
import { hasGitLine, shownBranch } from "../app/gitLine";
import { hueColor } from "../app/hue";
import { pinKey, pinnedByWorkspace } from "../app/pins";
import { groupWorktrees } from "../app/worktreeGroups";
import { dropSlot, loadSort, moveIndex, saveSort, sortWorkspaces, type WorkspaceSort } from "../app/workspaceOrder";
import type { ListeningPort } from "../app/ports";
import type { Worktree } from "../changes/worktrees";
import type { Agent, AgentStatus, Snapshot, Tab, Workspace } from "../protocol";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { LoopMark } from "./LoopMark";
import {
  AttentionOrderIcon,
  BranchIcon,
  CodeIcon,
  CopyIcon,
  HandOrderIcon,
  OpenIcon,
  PinIcon,
  QueueIcon,
  RenameIcon,
  TeamIcon,
} from "./icons";
import { Ports } from "./Ports";
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

export function Sidebar({
  controller,
  snapshot,
  changedFiles,
  worktrees,
  onOpenWorktrees,
  queues,
  onOpenQueue,
  pins,
  ports,
}: {
  controller: Controller;
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
}) {
  const [sort, setSort] = useState(loadSort);
  // The team file sits in the workspace's own folder, not wherever its active tab has wandered.
  const folderOf = (workspace: Workspace) => (snapshot && workspaceFolder(workspace, snapshot)) || null;
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
  return (
    <nav className="sidebar" aria-label="Workspaces">
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
          const path = snapshot && workspaceDirectory(workspace, snapshot);
          const marks = workspaceMarks(own, workspace.agent_status);
          const needsYou = marks.some((mark) => mark.status === "blocked");
          const listening = ports.get(workspace.workspace_id) ?? [];
          const focus = () => {
            if (drag.consumeClick()) return;
            controller.request("workspace.focus", { workspace_id: workspace.workspace_id });
          };
          const gitLine = (
            <WorkspaceGit
              branch={workspace.branch}
              aheadBehind={workspace.git_ahead_behind}
              changed={changedFiles.get(workspace.workspace_id) ?? 0}
              worktrees={worktrees.get(workspace.workspace_id) ?? []}
              onOpenWorktrees={() => onOpenWorktrees(workspace.workspace_id)}
            />
          );
          return (
            <li
              key={workspace.workspace_id}
              className={[drag.rowClass(index, workspaces.length), parent && "worktree-child"].filter(Boolean).join(" ") || undefined}
            >
              {/* A worktree hangs off its main checkout's card, on that card's rail color. */}
              {parent && <span className="worktree-link" aria-hidden="true" />}
              <div
                className={["workspace", workspace.focused && "current", needsYou && "needs-you"].filter(Boolean).join(" ")}
                style={{ "--rail": hueColor((parent ?? workspace).label) } as CSSProperties}
                title={parent ? `A worktree of ${parent.label}` : undefined}
                {...drag.handlers(index)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const folder = workspace.new_workspace_cwd || path;
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
                      <AgentTally agents={own} marks={marks} />
                    </span>
                    {gitLine}
                  </div>
                ) : (
                  <button
                    className="workspace-main"
                    aria-current={workspace.focused ? "true" : undefined}
                    onClick={focus}
                    onDoubleClick={() => setRenaming(workspace.workspace_id)}
                  >
                    <span className="workspace-head">
                      <span className="workspace-label" title={path || undefined}>
                        {workspace.label}
                      </span>
                      <AgentTally agents={own} marks={marks} />
                    </span>
                    {gitLine}
                  </button>
                )}
                {/* What else lives here, a chip each on the card's last line, so the
                    name keeps its width however much is going on. Beside the
                    card's button, not in it: a port is a button of its own. */}
                <div className="workspace-tray" onClick={focus}>
                  <QueueChip queue={queues.get(workspace.workspace_id) ?? null} onOpen={() => onOpenQueue(workspace.workspace_id)} />
                  <PinnedTabs tabs={pinned.get(workspace.workspace_id) ?? []} />
                  <LoopMark tags={loopTags(own)} />
                  <Ports ports={listening} />
                </div>
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

/// The branch line, as herdr-gpui's folder card has it: the branch unless it is
/// `main` or `master`, commits to push and pull, how many files are changed, and
/// how many linked worktrees the checkout has. Only what is non-zero shows, and
/// the line is gone when that leaves nothing.
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
      {ahead > 0 && <span className="git-ahead" title={`${ahead} to push`}>↑{ahead}</span>}
      {behind > 0 && <span className="git-behind" title={`${behind} to pull`}>↓{behind}</span>}
      {changed > 0 && (
        <span className="git-changed" title={`${changed} changed ${changed === 1 ? "file" : "files"}`}>
          ±{changed}
        </span>
      )}
      <Worktrees worktrees={worktrees} onOpen={onOpenWorktrees} />
    </span>
  );
}
