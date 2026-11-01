import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentCountsByTab, clearOutcomeParams, loopTags, outcomeNeedsYou, tabNeedsYou, tabVerifiedDone, unseenDone } from "../app/attention";
import type { Controller } from "../app/controller";
import { moveChoices, splitName, tabMove } from "../app/moveTab";
import { pinIndex, pinKey, savePins, stripOrder } from "../app/pins";
import { tabDirectory } from "../app/sharedCheckout";
import { useSteadyStrip } from "../app/useSteadyStrip";
import type { Agent, Snapshot, Tab } from "../protocol";
import { AgentCount } from "./AgentCount";
import { CloseDialog } from "./CloseDialog";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { folderMenu } from "./folderMenu";
import { BranchIcon, CheckIcon, NewTabIcon, OpenIcon, PinIcon, QueueIcon, RenameIcon, TerminalIcon } from "./icons";
import { LoopMark } from "./LoopMark";
import { RenameField } from "./RenameField";
import { StatusMark } from "./StatusMark";

/// Whether ⌥ is down. ⌘-Tab away never delivers the key's release, so losing the
/// window lets go of it.
function useOptionHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => setHeld(event.altKey);
    const onBlur = () => setHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return held;
}

export function TabBar({
  controller,
  snapshot,
  worktreeTabs,
  pins,
  onPinsChange,
  wrap,
  newTabCommand,
  onMarkSeen,
  onOpenQueue,
  onSplit,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  /// The tabs working in a linked worktree.
  worktreeTabs: ReadonlySet<string>;
  pins: Set<string>;
  onPinsChange: (pins: Set<string>) => void;
  wrap: boolean;
  newTabCommand: string | null;
  onMarkSeen: (agents: Agent[]) => void;
  onOpenQueue: (workspaceId: string) => void;
  /// A tab that was in `folder` now has the new workspace `workspaceId` to itself.
  onSplit: (workspaceId: string, folder: string) => void;
}) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Without a command the button opens a plain terminal either way, so ⌥ changes nothing.
  const plainTab = useOptionHeld() && !!newTabCommand;
  const newTabHint = newTabCommand ? "New tab (⌥-click for a plain terminal)" : "New tab";

  const bootId = snapshot?.boot_id ?? "";
  const isPinned = (tab: Tab) => pins.has(pinKey(bootId, tab.tab_id));
  const strip = useSteadyStrip(snapshot?.tabs ?? [], snapshot?.focused_workspace_id ?? null);
  const tabs = stripOrder(
    snapshot?.tabs.filter((tab) => tab.workspace_id === snapshot.focused_workspace_id) ?? [],
    isPinned,
    (tab) => strip.working.has(tab.tab_id),
  );
  const agentCounts = snapshot ? agentCountsByTab(snapshot) : new Map<string, number>();

  // Stepping through tabs follows the order they are drawn in.
  useEffect(() => {
    controller.stripTabs = tabs.map((tab) => tab.tab_id);
  });

  // On one row the open tab can sit past the edge, so it is scrolled to.
  const rows = useRef<HTMLDivElement>(null);
  const focusedTab = tabs.find((tab) => tab.focused)?.tab_id;
  useEffect(() => {
    if (wrap) return;
    rows.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [wrap, focusedTab, tabs.length]);

  /// A click on a tab that only just moved was aimed at another one, so it does nothing.
  const closeByPointer = (tab: Tab) => {
    if (strip.settled()) controller.request("tab.close", { tab_id: tab.tab_id });
  };

  const togglePin = (tab: Tab) => {
    if (!snapshot) return;
    const next = new Set(pins);
    const key = pinKey(bootId, tab.tab_id);
    if (!next.delete(key)) next.add(key);
    onPinsChange(next);
    savePins(next, bootId);
    const index = pinIndex(snapshot.tabs, tab, (other) => next.has(pinKey(bootId, other.tab_id)));
    controller.request("tab.move", { tab_id: tab.tab_id, insert_index: index });
  };

  const moveTo = (tab: Tab, workspaceId: string) => {
    if (!snapshot) return;
    const { panes, label } = tabMove(tab, snapshot);
    controller.act(invoke("move_tab", { panes, workspaceId, label }));
  };

  /// Looks again at the tabs, which may have changed while the name was typed.
  const splitOff = (tab: Tab, name: string) => {
    if (!snapshot || !moveChoices(tab, snapshot).canSplit) return;
    const { panes, label, folder } = tabMove(tab, snapshot);
    controller.act(
      invoke<string>("move_tab_to_new_workspace", { panes, name, label }).then((workspaceId) => {
        if (folder) onSplit(workspaceId, folder);
      }),
    );
  };

  /// The tab menu. It opens on the tab's own actions, so Enter never makes a
  /// new tab, and ends with the ones that add or remove a tab.
  const tabMenu = (tab: Tab): MenuItem[][] => {
    const { others, canSplit } = moveChoices(tab, snapshot);
    const pinned = isPinned(tab);
    const folder = snapshot && tabDirectory(tab, snapshot);
    // The agents as they stand now: one that finishes again before the pick
    // has a new sequence, so its mark stays.
    const own = snapshot?.agents.filter((agent) => agent.tab_id === tab.tab_id) ?? [];
    const finished = unseenDone(own);
    const needYou = own.filter(outcomeNeedsYou);
    return [
      [
        { label: "Rename…", icon: <RenameIcon />, onSelect: () => setRenaming(tab.tab_id) },
        { label: pinned ? "Unpin" : "Pin", icon: <PinIcon />, onSelect: () => togglePin(tab) },
        {
          label: "Mark as Seen",
          icon: <CheckIcon />,
          // Stays when there is nothing to mark, so the rows below don't jump.
          disabled: finished.length === 0,
          onSelect: () => onMarkSeen(finished),
        },
        // Only when it applies: most tabs never need it, unlike Mark as Seen.
        ...(needYou.length > 0
          ? [
              {
                label: "Clear Needs You",
                icon: <CheckIcon />,
                onSelect: () => needYou.forEach((agent) => controller.request("pane.report_metadata", clearOutcomeParams(agent))),
              },
            ]
          : []),
      ],
      [
        ...(folder
          ? [
              {
                label: "Add to Queue…",
                icon: <QueueIcon />,
                hint: controller.shortcutHint("add_to_queue"),
                onSelect: () => onOpenQueue(tab.workspace_id),
              },
              { label: "Folder", icon: <OpenIcon />, items: folderMenu(controller, folder) },
            ]
          : []),
        {
          label: "Move to Workspace",
          disabled: !canSplit && others.length === 0,
          items: [
            [
              {
                label: "New Workspace…",
                hint: canSplit ? undefined : "Only tab here",
                disabled: !canSplit,
                onSelect: () => setSplitting(tab.tab_id),
              },
            ],
            others.map((workspace) => ({
              label: workspace.label,
              onSelect: () => moveTo(tab, workspace.workspace_id),
            })),
          ],
        },
      ],
      [
        // As the + button: the shortcut that does the same is ⌘⇧T, not ⌘T's plain terminal.
        { label: "New Tab", icon: <NewTabIcon />, hint: controller.shortcutHint("new_command_tab"), onSelect: () => controller.newTab() },
        {
          label: "Close Tab",
          hint: pinned ? "Unpin first" : controller.shortcutHint("close_tab"),
          disabled: pinned,
          onSelect: () => controller.request("tab.close", { tab_id: tab.tab_id }),
        },
      ],
    ];
  };

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div
        ref={rows}
        className={wrap ? "tab-rows" : "tab-rows one-row"}
        role="tablist"
        aria-label="Tabs"
        data-tauri-drag-region
        onPointerEnter={strip.hold}
        onPointerLeave={strip.release}
        // A mouse wheel only scrolls up and down, and the row only goes sideways.
        onWheel={(event) => {
          if (!wrap) event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {tabs.map((tab) => {
          const pinned = isPinned(tab);
          const agents = agentCounts.get(tab.tab_id) ?? 0;
          const own = snapshot?.agents.filter((agent) => agent.tab_id === tab.tab_id) ?? [];
          const waiting = tabNeedsYou(own);
          return (
            <div
              key={tab.tab_id}
              className="tab"
              role="tab"
              aria-selected={tab.focused}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, items: tabMenu(tab) });
              }}
            >
              {renaming === tab.tab_id ? (
                <RenameField
                  className="tab-rename"
                  label="Tab name"
                  initial={tab.custom_label ? tab.label : ""}
                  onDone={(label) => {
                    setRenaming(null);
                    controller.focusTerminal();
                    if (label !== null) controller.request("tab.rename", { tab_id: tab.tab_id, label });
                  }}
                />
              ) : splitting === tab.tab_id ? (
                <>
                  <span className="tab-split-hint">New workspace</span>
                  <RenameField
                    className="tab-rename"
                    label="New workspace name"
                    initial={splitName(tab)}
                    onDone={(name) => {
                      setSplitting(null);
                      controller.focusTerminal();
                      if (name !== null) splitOff(tab, name);
                    }}
                  />
                </>
              ) : (
                <button
                  className="tab-label"
                  title={tab.label}
                  // The button never takes focus: typing stays with the terminal.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => controller.request("tab.focus", { tab_id: tab.tab_id })}
                  onDoubleClick={() => setRenaming(tab.tab_id)}
                  onAuxClick={(event) => event.button === 1 && !pinned && closeByPointer(tab)}
                >
                  {pinned && (
                    <span className="tab-pin" title="Pinned" aria-label="Pinned">
                      <PinIcon />
                    </span>
                  )}
                  {worktreeTabs.has(tab.tab_id) && (
                    <span className="tab-worktree-mark" title="In a worktree" aria-label="In a worktree">
                      <BranchIcon />
                    </span>
                  )}
                  <span className="tab-text">{tab.label}</span>
                  <LoopMark tags={loopTags(own)} />
                  {agents > 1 && <AgentCount count={agents} />}
                  {tab.zoomed && <span className="tab-zoomed" title="Zoomed">⤢</span>}
                  <StatusMark status={waiting === null ? tab.agent_status : "blocked"} verified={tabVerifiedDone(own)} note={waiting} />
                </button>
              )}
              {!pinned && (
                <button
                  className="tab-close"
                  aria-label={`Close ${tab.label}`}
                  title="Close tab"
                  onClick={() => closeByPointer(tab)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          className={plainTab ? "icon-button new-tab plain" : "icon-button new-tab"}
          title={plainTab ? "Plain terminal" : newTabHint}
          aria-label={plainTab ? "Plain terminal" : "New tab"}
          disabled={!snapshot?.focused_workspace_id}
          // Typing goes to the tab this opens: the press must not take focus
          // from the terminal, and focus elsewhere is handed back to it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (event.altKey) controller.run("new_tab");
            else controller.newTab();
            controller.focusTerminal();
          }}
        >
          {plainTab ? <TerminalIcon /> : <NewTabIcon />}
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
      <CloseDialog controller={controller} />
    </div>
  );
}
