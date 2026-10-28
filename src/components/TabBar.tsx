import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { loadPins, pinIndex, pinKey, pinnedFirst, savePins } from "../app/pins";
import type { Snapshot, Tab } from "../protocol";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { StatusMark } from "./StatusMark";

export function TabBar({
  controller,
  snapshot,
  changes,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  changes: boolean;
}) {
  const [pins, setPins] = useState(loadPins);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const barRef = useRef<HTMLDivElement>(null);

  const bootId = snapshot?.boot_id ?? "";
  const isPinned = (tab: Tab) => pins.has(pinKey(bootId, tab.tab_id));
  const tabs = pinnedFirst(
    snapshot?.tabs.filter((tab) => tab.workspace_id === snapshot.focused_workspace_id) ?? [],
    isPinned,
  );

  const togglePin = (tab: Tab) => {
    if (!snapshot) return;
    const next = new Set(pins);
    const key = pinKey(bootId, tab.tab_id);
    if (!next.delete(key)) next.add(key);
    setPins(next);
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

  // The bar has no scrollbar, so keep the focused tab in view.
  const focusedId = tabs.find((tab) => tab.focused)?.tab_id;
  useEffect(() => {
    barRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusedId]);

  return (
    <div
      ref={barRef}
      className="tabbar"
      role="tablist"
      aria-label="Tabs"
      onWheel={(event) => {
        if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
      {tabs.map((tab) => {
        const pinned = isPinned(tab);
        return (
          <div
            key={tab.tab_id}
            className={`tab${pinned ? " tab-pinned" : ""}`}
            role="tab"
            aria-selected={tab.focused}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, items: tabMenu(tab) });
            }}
          >
            {renaming === tab.tab_id ? (
              <RenameField
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
                {tab.zoomed && <span className="tab-zoomed" title="Zoomed">⤢</span>}
              </button>
            )}
            {!pinned && (
              <button
                className="tab-close"
                aria-label={`Close ${tab.label}`}
                title="Close tab"
                onClick={() => controller.request("tab.close", { tab_id: tab.tab_id })}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      <button
        className="icon-button"
        title="New tab"
        aria-label="New tab"
        disabled={!snapshot?.focused_workspace_id}
        // Typing goes to the tab this opens: the press must not take focus
        // from the terminal, and focus elsewhere is handed back to it.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          controller.run("new_tab");
          controller.focusTerminal();
        }}
      >
        +
      </button>
      <span className="tabbar-spacer" />
      <button
        className="icon-button changes-toggle"
        title="Changes"
        aria-label="Changes"
        aria-pressed={changes}
        onClick={() => controller.run("review_changes")}
      >
        ±
      </button>
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </div>
  );
}

/// Inline rename: Enter saves, Escape or leaving cancels. An empty name is
/// not sent, so the tab keeps the name Herdr gives it.
function RenameField({ initial, onDone }: { initial: string; onDone: (label: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="tab-rename"
      aria-label="Tab name"
      autoFocus
      value={value}
      maxLength={200}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(null)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onDone(value.trim() || null);
        else if (event.key === "Escape") onDone(null);
      }}
    />
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10 2.5 13.5 6l-2 .75-2.25 2.25.25 3L8 13.5 2.5 8 4 6.5l3 .25L9.25 4.5Z M5.25 10.75 2.5 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
