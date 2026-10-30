import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { agentCountsByTab, loopTags } from "../app/attention";
import type { Controller } from "../app/controller";
import { pinIndex, pinKey, savePins, stripOrder } from "../app/pins";
import type { Snapshot, Tab } from "../protocol";
import { AgentCount } from "./AgentCount";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { PinIcon } from "./icons";
import { LoopMark } from "./LoopMark";
import { RenameField } from "./RenameField";
import { StatusMark } from "./StatusMark";

export function TabBar({
  controller,
  snapshot,
  pins,
  onPinsChange,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  pins: Set<string>;
  onPinsChange: (pins: Set<string>) => void;
}) {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const bootId = snapshot?.boot_id ?? "";
  const isPinned = (tab: Tab) => pins.has(pinKey(bootId, tab.tab_id));
  const tabs = stripOrder(
    snapshot?.tabs.filter((tab) => tab.workspace_id === snapshot.focused_workspace_id) ?? [],
    isPinned,
  );
  const agentCounts = snapshot ? agentCountsByTab(snapshot) : new Map<string, number>();

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
    <div className="tabbar">
      <div className="tab-rows" role="tablist" aria-label="Tabs">
        {tabs.map((tab) => {
          const pinned = isPinned(tab);
          const agents = agentCounts.get(tab.tab_id) ?? 0;
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
                  onAuxClick={(event) =>
                    event.button === 1 && !pinned && controller.request("tab.close", { tab_id: tab.tab_id })
                  }
                >
                  {pinned && (
                    <span className="tab-pin" title="Pinned" aria-label="Pinned">
                      <PinIcon />
                    </span>
                  )}
                  <StatusMark status={tab.agent_status} />
                  <span className="tab-text">{tab.label}</span>
                  <LoopMark tags={loopTags(snapshot?.agents.filter((agent) => agent.tab_id === tab.tab_id) ?? [])} />
                  {agents > 1 && <AgentCount count={agents} />}
                  {tab.zoomed && <span className="tab-zoomed" title="Zoomed">⤢</span>}
                </button>
              )}
              <button
                className="tab-close"
                aria-label={`Close ${tab.label}`}
                title="Close tab"
                onClick={() => controller.request("tab.close", { tab_id: tab.tab_id })}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          className="icon-button"
          title="New tab (⌥-click for a plain terminal)"
          aria-label="New tab"
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
          +
        </button>
      </div>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}
