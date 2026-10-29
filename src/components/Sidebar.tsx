import { type CSSProperties, type PointerEvent, useCallback, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { copyPath, openFolder, tildePath } from "../app/folder";
import { useHome } from "../app/useHome";
import { workspaceDirectory } from "../changes/counts";
import { agentsByWorkspace, workspaceMarks } from "../app/attention";
import { hueColor } from "../app/hue";
import { pinKey, pinnedByWorkspace } from "../app/pins";
import { dropSlot, loadSort, moveIndex, saveSort, sortWorkspaces, type WorkspaceSort } from "../app/workspaceOrder";
import type { ListeningPort } from "../app/ports";
import type { Worktree } from "../changes/worktrees";
import type { Agent, Snapshot, Tab } from "../protocol";
import { AgentCount } from "./AgentCount";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import {
  AttentionOrderIcon,
  BranchIcon,
  CodeIcon,
  CopyIcon,
  HandOrderIcon,
  OpenIcon,
  PinIcon,
} from "./icons";
import { Ports } from "./Ports";
import { Worktrees } from "./Worktrees";
import { StatusMark } from "./StatusMark";

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
  /// Pinned tabs, as `pinKey`s.
  pins: Set<string>;
  /// Ports each workspace's servers listen on, by workspace id; absent when none.
  ports: Map<string, ListeningPort[]>;
}) {
  const [sort, setSort] = useState(loadSort);
  const workspaces = sortWorkspaces(snapshot?.workspaces ?? [], sort);
  const drag = useRowDrag(sort === "manual", (from, slot) => {
    const workspace = snapshot?.workspaces[from];
    const index = moveIndex(from, slot);
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
  const home = useHome();
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
        {workspaces.map((workspace, index) => {
          const own = agents.get(workspace.workspace_id) ?? [];
          const path = snapshot && workspaceDirectory(workspace, snapshot);
          const marks = workspaceMarks(own, workspace.agent_status);
          const needsYou = marks.some((mark) => mark.status === "blocked");
          const listening = ports.get(workspace.workspace_id) ?? [];
          return (
            <li key={workspace.workspace_id} className={drag.rowClass(index, workspaces.length)}>
              <button
                className={["workspace", needsYou && "needs-you", listening.length > 0 && "has-ports"].filter(Boolean).join(" ")}
                style={{ "--rail": hueColor(workspace.label) } as CSSProperties}
                aria-current={workspace.focused ? "true" : undefined}
                {...drag.handlers(index)}
                onClick={() => {
                  if (drag.consumeClick()) return;
                  controller.request("workspace.focus", { workspace_id: workspace.workspace_id });
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (path) setMenu({ x: event.clientX, y: event.clientY, items: folderMenu(controller, path) });
                }}
              >
                <span className="workspace-text">
                  <span className="workspace-label">{workspace.label}</span>
                  {path && (
                    <span className="workspace-path" title={path}>
                      {tildePath(path, home)}
                    </span>
                  )}
                  <WorkspaceGit
                    branch={workspace.branch}
                    aheadBehind={workspace.git_ahead_behind}
                    changed={changedFiles.get(workspace.workspace_id) ?? 0}
                    worktrees={worktrees.get(workspace.workspace_id) ?? []}
                    onOpenWorktrees={() => onOpenWorktrees(workspace.workspace_id)}
                  />
                </span>
                <span className="workspace-marks">
                  <PinnedTabs tabs={pinned.get(workspace.workspace_id) ?? []} />
                  <AgentCount count={own.length} />
                  {marks.map(({ status, count }) => (
                    <StatusMark key={status} status={status} count={status === "blocked" ? count : undefined} />
                  ))}
                </span>
              </button>
              {/* Beside the card's button, not in it: each port is a button of its own. */}
              {listening.length > 0 && (
                <span className="workspace-ports">
                  <Ports ports={listening} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {snapshot && workspaces.length === 0 && <p className="empty">No workspaces. Press + to open one.</p>}
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

/// The branch line, as herdr-gpui's folder card has it: the branch, commits to
/// push and pull, how many files are changed, and how many linked worktrees
/// the checkout has. Only what is non-zero shows.
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
  if (!branch && !changed && worktrees.length === 0) return null;
  return (
    <span className="workspace-branch">
      {branch && <span className="workspace-branch-name">{branch}</span>}
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
