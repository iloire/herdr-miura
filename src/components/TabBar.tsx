import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentCountsByTab, loopTags, tabNeedsYou, tabVerifiedDone } from "../app/attention";
import type { Controller } from "../app/controller";
import { pinIndex, pinKey, savePins, stripOrder } from "../app/pins";
import { useSteadyStrip } from "../app/useSteadyStrip";
import type { Snapshot, Tab } from "../protocol";
import { AgentCount } from "./AgentCount";
import { CloseDialog } from "./CloseDialog";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { NewTabIcon, PinIcon, TerminalIcon } from "./icons";
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
  pins,
  onPinsChange,
  wrap,
  newTabCommand,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  pins: Set<string>;
  onPinsChange: (pins: Set<string>) => void;
  wrap: boolean;
  newTabCommand: string | null;
}) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
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
    const panes = snapshot?.panes.filter((pane) => pane.tab_id === tab.tab_id).map((pane) => pane.pane_id) ?? [];
    controller.act(
      invoke("move_tab", { panes, workspaceId, label: tab.custom_label ? tab.label : null }),
    );
  };

  /// The tab menu, as herdr-gpui's: new, rename, pin, move, close.
  const tabMenu = (tab: Tab): MenuItem[] => {
    const others = snapshot?.workspaces.filter((workspace) => workspace.workspace_id !== tab.workspace_id) ?? [];
    return [
      { label: "New Tab", onSelect: () => controller.run("new_tab") },
      { label: "Rename", onSelect: () => setRenaming(tab.tab_id) },
      { label: isPinned(tab) ? "Unpin" : "Pin", onSelect: () => togglePin(tab) },
      {
        label: "Move to Workspace",
        disabled: others.length === 0,
        items: others.map((workspace) => ({
          label: workspace.label,
          onSelect: () => moveTo(tab, workspace.workspace_id),
        })),
      },
      { label: "Close Tab", onSelect: () => controller.request("tab.close", { tab_id: tab.tab_id }) },
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
                ×
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
    </div>
  );
}
