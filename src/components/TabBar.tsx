import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { agentCountsByTab, loopTags, outcomeNeedsYou, tabNeedsYou, tabVerifiedDone, unseenDone } from "../app/attention";
import type { Controller } from "../app/controller";
import { type HueSlot, slotTint } from "../app/hue";
import { moveChoices, splitName, tabMove } from "../app/moveTab";
import { pinIndex, pinKey, savePins } from "../app/pins";
import { tabDirectory } from "../app/sharedCheckout";
import { saveTabColors } from "../app/tabColors";
import { loadTabSort, saveTabSort, stripOrder, tabRanks, type TabSort } from "../app/tabOrder";
import type { Direction } from "../app/tabHistory";
import { useSteadyStrip } from "../app/useSteadyStrip";
import type { Agent, Snapshot, Tab } from "../protocol";
import { AgentCount } from "./AgentCount";
import { AlertDialog } from "./AlertDialog";
import { PastedImageDialog } from "./PastedImageDialog";
import { CloseDialog } from "./CloseDialog";
import { colorSwatches } from "./colorSwatches";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { folderMenu } from "./folderMenu";
import {
  BackIcon,
  BranchIcon,
  CheckIcon,
  ForwardIcon,
  NewTabIcon,
  NextTabIcon,
  OpenIcon,
  PinIcon,
  PreviousTabIcon,
  QueueIcon,
  RenameIcon,
  TerminalIcon,
} from "./icons";
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
  tabColors,
  onTabColorsChange,
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
  /// Each colored tab's slot, by `pinKey`.
  tabColors: ReadonlyMap<string, HueSlot>;
  onTabColorsChange: (colors: ReadonlyMap<string, HueSlot>) => void;
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

  const workspaceLabel = (workspaceId: string) => snapshot?.workspaces.find((w) => w.workspace_id === workspaceId)?.label;
  const elsewhere = (tab: Tab) => (tab.workspace_id === snapshot?.focused_workspace_id ? undefined : workspaceLabel(tab.workspace_id));

  // The controller's history moves in the same update as the snapshot, so it is current here.
  const steps = (["back", "forward"] as const).map((direction) => {
    const target = controller.tabStep(direction);
    const tab = target ? snapshot?.tabs.find((t) => t.tab_id === target) : undefined;
    const command = direction === "back" ? "go_back" : "go_forward";
    const word = direction === "back" ? "Back" : "Forward";
    const key = controller.shortcutHint(command);
    const where = tab && elsewhere(tab);
    const label = tab ? `${word} to ${tab.label}${where ? ` in ${where}` : ""}` : word;
    return { direction, command, tab, hint: `${label}${key ? ` (${key})` : ""}` };
  });

  // While Back or Forward is hovered, the tab it would focus is outlined: on the
  // strip, or its workspace's card when it is in another one.
  const [preview, setPreview] = useState<Direction | null>(null);
  const previewTab = preview ? steps.find((step) => step.direction === preview)?.tab : undefined;
  const previewCard = previewTab && previewTab.workspace_id !== snapshot?.focused_workspace_id ? previewTab.workspace_id : null;
  useEffect(() => {
    if (!previewCard) return;
    const card = document.querySelector(`.workspace[data-workspace-id="${CSS.escape(previewCard)}"]`);
    card?.setAttribute("data-step-preview", "");
    return () => card?.removeAttribute("data-step-preview");
  }, [previewCard]);

  /// Up to ten tabs from one side of the history, to jump straight to.
  const openHistory = (direction: Direction, x: number, y: number) => {
    const items = controller.tabTargets(direction).flatMap((id): MenuItem[] => {
      const tab = snapshot?.tabs.find((t) => t.tab_id === id);
      if (!tab) return [];
      return [{ label: tab.label, hint: workspaceLabel(tab.workspace_id), onSelect: () => controller.jumpTab(direction, id) }];
    });
    if (items.length > 0) setMenu({ x, y, items: [items] });
  };

  // A long press opens the same list as a right-click, and the click that ends it does nothing.
  const press = useRef<{ timer: number; opened: boolean } | null>(null);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const startPress = (direction: Direction, button: HTMLElement) => {
    endPress();
    const held = {
      opened: false,
      timer: window.setTimeout(() => {
        held.opened = true;
        const box = button.getBoundingClientRect();
        openHistory(direction, box.left, box.bottom);
      }, 400),
    };
    press.current = held;
  };
  useEffect(() => endPress, []);

  const bootId = snapshot?.boot_id ?? "";
  const isPinned = (tab: Tab) => pins.has(pinKey(bootId, tab.tab_id));
  const tabColor = (tab: Tab) => tabColors.get(pinKey(bootId, tab.tab_id)) ?? null;
  const [sort, setSort] = useState(loadTabSort);
  const strip = useSteadyStrip(
    tabRanks(snapshot?.tabs ?? [], sort, snapshot?.agents ?? []),
    snapshot?.tabs ?? [],
    snapshot?.focused_workspace_id ?? null,
  );
  const tabs = stripOrder(
    snapshot?.tabs.filter((tab) => tab.workspace_id === snapshot.focused_workspace_id) ?? [],
    isPinned,
    strip.ranks,
  );
  const agentCounts = snapshot ? agentCountsByTab(snapshot) : new Map<string, number>();
  const at = tabs.findIndex((tab) => tab.tab_id === snapshot?.focused_tab_id);
  // ‹ › move along this strip in drawn order, wrapping, as ⌘⇧[ and ⌘⇧] do.
  const strideTo = (
    [
      ["previous_tab", -1, "Previous tab"],
      ["next_tab", 1, "Next tab"],
    ] as const
  ).map(([command, step, word]) => {
    const tab = tabs.length > 1 && at >= 0 ? tabs[(at + step + tabs.length) % tabs.length] : undefined;
    const key = controller.shortcutHint(command);
    return { command, step, tab, hint: `${tab ? `${word}: ${tab.label}` : word}${key ? ` (${key})` : ""}` };
  });

  // Stepping through tabs follows the order they are drawn in.
  useEffect(() => {
    controller.stripTabs = tabs.map((tab) => tab.tab_id);
  });

  // On one row the open tab can sit past the edge, so it is scrolled to, also
  // when the sort carries it there.
  const rows = useRef<HTMLDivElement>(null);
  const focusedTab = tabs.find((tab) => tab.focused)?.tab_id;
  const order = tabs.map((tab) => tab.tab_id).join();
  useEffect(() => {
    if (wrap) return;
    rows.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [wrap, focusedTab, order]);

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

  const chooseColor = (tab: Tab, slot: HueSlot | null) => {
    const next = new Map(tabColors);
    const key = pinKey(bootId, tab.tab_id);
    if (slot) next.set(key, slot);
    else next.delete(key);
    onTabColorsChange(next);
    saveTabColors(next, bootId);
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

  const sortChoice = (label: string, choice: TabSort): MenuItem => ({
    label,
    icon: sort === choice ? <CheckIcon /> : undefined,
    onSelect: () => {
      setSort(choice);
      saveTabSort(choice);
    },
  });

  /// The tab menu. It opens on the tab's own actions, so Enter never closes
  /// the tab, and ends with Close Tab.
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
                onSelect: () => controller.clearNeedsYou(needYou),
              },
            ]
          : []),
        colorSwatches("Tab color", "None", tabColor(tab), (slot) => chooseColor(tab, slot), slotTint),
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
      [{ label: "Sort Tabs", items: [[sortChoice("Working First", "working"), sortChoice("Needs You First", "attention")]] }],
      [
        {
          label: "Close Tab",
          hint: controller.shortcutHint("close_tab"),
          onSelect: () => controller.request("tab.close", { tab_id: tab.tab_id }),
        },
      ],
    ];
  };

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tab-nav" data-tauri-drag-region>
        {steps.map((step) => (
          <button
            key={step.direction}
            className="icon-button"
            title={step.hint}
            aria-label={step.hint}
            aria-haspopup="menu"
            disabled={!step.tab}
            // Typing stays with the terminal, which the tab moved to takes over.
            onMouseDown={(event) => event.preventDefault()}
            onPointerEnter={() => setPreview(step.direction)}
            onPointerLeave={() => {
              setPreview(null);
              endPress();
            }}
            onPointerDown={(event) => {
              if (event.button === 0) startPress(step.direction, event.currentTarget);
            }}
            onPointerUp={endPress}
            onContextMenu={(event) => {
              event.preventDefault();
              endPress();
              openHistory(step.direction, event.clientX, event.clientY);
            }}
            onClick={() => {
              if (press.current?.opened) press.current = null;
              else controller.run(step.command);
            }}
          >
            {step.direction === "back" ? <BackIcon /> : <ForwardIcon />}
          </button>
        ))}
      </div>
      <span className="tab-nav-divider" aria-hidden="true" />
      <div className="tab-nav tab-cycle" data-tauri-drag-region>
        {strideTo.map((stride) => (
          <button
            key={stride.command}
            className="icon-button"
            title={stride.hint}
            aria-label={stride.hint}
            disabled={!stride.tab}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => controller.run(stride.command)}
          >
            {stride.step < 0 ? <PreviousTabIcon /> : <NextTabIcon />}
          </button>
        ))}
      </div>
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
          const color = tabColor(tab);
          return (
            <div
              key={tab.tab_id}
              className={["tab", color && "tinted", previewTab?.tab_id === tab.tab_id && "step-target"].filter(Boolean).join(" ")}
              style={color ? ({ "--tab-tint": slotTint(color) } as CSSProperties) : undefined}
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
                  onAuxClick={(event) => event.button === 1 && closeByPointer(tab)}
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
              <button
                className="tab-close"
                aria-label={`Close ${tab.label}`}
                title="Close tab"
                onClick={() => closeByPointer(tab)}
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
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
      <AlertDialog controller={controller} />
      <PastedImageDialog controller={controller} />
    </div>
  );
}
