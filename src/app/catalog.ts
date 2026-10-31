import type { Snapshot } from "../protocol";

/// An endpoint request a command turns into against the latest snapshot.
export interface Request {
  method: string;
  params: Record<string, unknown>;
}

export interface CatalogEntry {
  name: string;
  label: string;
  /// GPUI keystroke syntax, such as `cmd-shift-d`.
  shortcuts: string[];
}

type Direction = "left" | "right" | "up" | "down";

/// What running a command does: a request built from the snapshot, or
/// `window` for one the controller handles itself. A builder returns `null`
/// when the snapshot has nothing to act on, such as no focused pane.
type Action = "window" | ((focus: Focus) => Request | null);

interface Definition {
  name: string;
  label: string;
  /// Defaults on macOS, then on Linux and Windows. Linux keeps Super for
  /// the desktop and plain Ctrl for terminal programs, so its keys add Shift.
  mac: string[];
  other: string[];
  action: Action;
}

/// The focused workspace, tab, and pane, each only when it sits inside the
/// one before, so a stale ID never targets another workspace's tab.
export interface Focus {
  snapshot: Snapshot;
  workspace: Snapshot["workspaces"][number] | undefined;
  tab: Snapshot["tabs"][number] | undefined;
  pane: Snapshot["panes"][number] | undefined;
  /// Tab IDs as the strip draws them. See `Controller.stripTabs`.
  strip: readonly string[];
}

export function focusOf(snapshot: Snapshot, strip: readonly string[] = []): Focus {
  const workspace = snapshot.workspaces.find((w) => w.workspace_id === snapshot.focused_workspace_id);
  const tab =
    workspace &&
    snapshot.tabs.find((t) => t.tab_id === snapshot.focused_tab_id && t.workspace_id === workspace.workspace_id);
  const pane =
    tab &&
    snapshot.panes.find(
      (p) => p.pane_id === snapshot.focused_pane_id && p.tab_id === tab.tab_id && p.workspace_id === tab.workspace_id,
    );
  return { snapshot, workspace, tab, pane, strip };
}

/// Index `step` places from `index` in a cycle of `length`.
function cycle(index: number, step: number, length: number): number {
  return (index + step + length) % length;
}

function onPane(method: string, extra: Record<string, unknown> = {}) {
  return ({ pane }: Focus): Request | null => (pane ? { method, params: { pane_id: pane.pane_id, ...extra } } : null);
}

function directional(prefix: string, method: string, label: string, mac: string[], other: string[]) {
  const directions: Direction[] = ["left", "right", "up", "down"];
  return directions.map(
    (direction, i): Definition => ({
      name: `${prefix}${direction}`,
      label: `${label} ${direction[0].toUpperCase()}${direction.slice(1)}`,
      mac: mac[i] ? [mac[i]] : [],
      other: other[i] ? [other[i]] : [],
      action: onPane(method, { direction }),
    }),
  );
}

/// `tabs` in the strip's order, which puts working tabs first without moving
/// them in the daemon. Any it hasn't drawn yet go last, in the daemon's order.
function inStripOrder<T extends { tab_id: string }>(tabs: T[], strip: readonly string[]): T[] {
  const place = (tab: T) => {
    const index = strip.indexOf(tab.tab_id);
    return index < 0 ? strip.length : index;
  };
  return tabs.sort((a, b) => place(a) - place(b));
}

function stepTab(step: number) {
  return ({ snapshot, workspace, strip }: Focus): Request | null => {
    if (!workspace) return null;
    const tabs = inStripOrder(snapshot.tabs.filter((t) => t.workspace_id === workspace.workspace_id), strip);
    const index = tabs.findIndex((t) => t.tab_id === snapshot.focused_tab_id);
    if (index < 0) return null;
    return { method: "tab.focus", params: { tab_id: tabs[cycle(index, step, tabs.length)].tab_id } };
  };
}

function stepPane(step: number) {
  return ({ snapshot, pane }: Focus): Request | null => {
    if (!pane) return null;
    const panes = snapshot.panes.filter((p) => p.workspace_id === pane.workspace_id && p.tab_id === pane.tab_id);
    const index = panes.findIndex((p) => p.pane_id === pane.pane_id);
    if (index < 0) return null;
    return { method: "pane.focus", params: { pane_id: panes[cycle(index, step, panes.length)].pane_id } };
  };
}

/// As Herdr's TUI moves a tab: the index counts the moving tab still in
/// place, and a tab at either end wraps around to the other.
function moveTab(next: boolean) {
  return ({ snapshot, tab }: Focus): Request | null => {
    if (!tab) return null;
    const tabs = snapshot.tabs.filter((t) => t.workspace_id === tab.workspace_id);
    if (tabs.length <= 1) return null;
    const source = tabs.findIndex((t) => t.tab_id === tab.tab_id);
    const insert = next ? (source + 1 === tabs.length ? 0 : source + 2) : source === 0 ? tabs.length : source - 1;
    return { method: "tab.move", params: { tab_id: tab.tab_id, insert_index: insert } };
  };
}

/// By position, as Herdr's `switch_tab` does: a tab's number is an ID that
/// is never reused, so it drifts from the strip once a tab closes.
function tabNumbers(): Definition[] {
  return Array.from({ length: 9 }, (_, i) => ({
    name: `focus_tab_${i + 1}`,
    label: `Focus Tab ${i + 1}`,
    mac: [`cmd-${i + 1}`],
    other: [`ctrl-shift-${i + 1}`],
    action: ({ snapshot, workspace }: Focus): Request | null => {
      const target = workspace && snapshot.tabs.filter((t) => t.workspace_id === workspace.workspace_id)[i];
      return target ? { method: "tab.focus", params: { tab_id: target.tab_id } } : null;
    },
  }));
}

function split(direction: "right" | "down") {
  return ({ pane }: Focus): Request | null =>
    pane ? { method: "pane.split", params: { target_pane_id: pane.pane_id, direction, focus: true } } : null;
}

/// Every command this app runs, with herdr-gpui's names, labels, and default
/// keys so muscle memory carries over. Shown in this order in the palette.
const DEFINITIONS: Definition[] = [
  {
    name: "new_workspace",
    label: "New Workspace",
    mac: ["cmd-shift-n"],
    other: ["ctrl-alt-shift-n"],
    action: ({ snapshot, workspace }) => {
      if (snapshot.focused_workspace_id === null) return { method: "workspace.create", params: { focus: true } };
      return workspace
        ? { method: "workspace.create", params: { focus: true, source_workspace_id: workspace.workspace_id } }
        : null;
    },
  },
  { name: "previous_workspace", label: "Previous Workspace", mac: [], other: [], action: "window" },
  { name: "next_workspace", label: "Next Workspace", mac: [], other: [], action: "window" },
  {
    name: "new_tab",
    label: "New Tab",
    mac: ["cmd-t"],
    other: ["ctrl-shift-t"],
    action: ({ workspace }) =>
      workspace ? { method: "tab.create", params: { workspace_id: workspace.workspace_id, focus: true } } : null,
  },
  { name: "new_command_tab", label: "New Tab with Command", mac: ["cmd-shift-t"], other: ["ctrl-alt-shift-t"], action: "window" },
  { name: "split_right", label: "Split Right", mac: ["cmd-d"], other: ["ctrl-shift-d"], action: split("right") },
  { name: "split_down", label: "Split Down", mac: ["cmd-shift-d"], other: ["ctrl-alt-shift-d"], action: split("down") },
  { name: "next_tab", label: "Next Tab", mac: ["cmd-shift-]"], other: ["ctrl-pagedown"], action: stepTab(1) },
  { name: "previous_tab", label: "Previous Tab", mac: ["cmd-shift-["], other: ["ctrl-pageup"], action: stepTab(-1) },
  { name: "move_tab_previous", label: "Move Tab Left", mac: [], other: [], action: moveTab(false) },
  { name: "move_tab_next", label: "Move Tab Right", mac: [], other: [], action: moveTab(true) },
  ...directional(
    "focus_",
    "pane.focus_direction",
    "Focus",
    ["cmd-alt-left", "cmd-alt-right", "cmd-alt-up", "cmd-alt-down"],
    ["ctrl-alt-shift-left", "ctrl-alt-shift-right", "ctrl-alt-shift-up", "ctrl-alt-shift-down"],
  ),
  { name: "next_pane", label: "Next Pane", mac: ["cmd-alt-]"], other: ["ctrl-alt-shift-]"], action: stepPane(1) },
  {
    name: "previous_pane",
    label: "Previous Pane",
    mac: ["cmd-alt-["],
    other: ["ctrl-alt-shift-["],
    action: stepPane(-1),
  },
  ...directional("swap_pane_", "pane.swap", "Swap Pane", [], []),
  // Herdr nudges the split by its own default step, as its TUI does.
  ...directional("resize_pane_", "pane.resize", "Resize Pane", [], []),
  {
    name: "toggle_zoom",
    label: "Toggle Pane Zoom",
    mac: ["cmd-shift-enter"],
    other: ["ctrl-shift-enter"],
    action: onPane("pane.zoom", { mode: "toggle" }),
  },
  { name: "clear_pane", label: "Clear Pane", mac: ["cmd-k"], other: ["ctrl-shift-k"], action: onPane("pane.clear") },
  {
    name: "edit_scrollback",
    label: "Open Scrollback in Editor",
    mac: [],
    other: [],
    action: onPane("pane.edit_scrollback"),
  },
  { name: "close_pane", label: "Close Pane", mac: ["cmd-w"], other: ["ctrl-shift-w"], action: onPane("pane.close") },
  {
    name: "close_tab",
    label: "Close Tab",
    mac: ["cmd-shift-w"],
    other: ["ctrl-alt-shift-w"],
    action: ({ tab }) => (tab ? { method: "tab.close", params: { tab_id: tab.tab_id } } : null),
  },
  ...tabNumbers(),
  { name: "toggle_sidebar", label: "Toggle Sidebar", mac: ["cmd-b"], other: ["ctrl-shift-b"], action: "window" },
  {
    name: "increase_font_size",
    label: "Increase Font Size",
    mac: ["cmd-=", "cmd-+"],
    other: ["ctrl-shift-=", "ctrl-shift-+"],
    action: "window",
  },
  { name: "decrease_font_size", label: "Decrease Font Size", mac: ["cmd--"], other: ["ctrl-shift--"], action: "window" },
  { name: "reset_font_size", label: "Reset Font Size", mac: ["cmd-0"], other: ["ctrl-shift-0"], action: "window" },
  { name: "open_settings", label: "Settings", mac: ["cmd-,"], other: ["ctrl-,"], action: "window" },
  { name: "command_palette", label: "Command Palette", mac: ["cmd-shift-p"], other: ["ctrl-shift-p"], action: "window" },
  { name: "review_changes", label: "Review Changes", mac: [], other: [], action: "window" },
  { name: "browse_files", label: "Browse Files", mac: ["cmd-shift-e"], other: ["ctrl-shift-e"], action: "window" },
  { name: "add_to_queue", label: "Add to Queue", mac: ["cmd-shift-a"], other: ["ctrl-shift-a"], action: "window" },
  { name: "prompt_library", label: "Prompt Library", mac: ["cmd-shift-l"], other: ["ctrl-shift-l"], action: "window" },
  { name: "detach", label: "Detach", mac: [], other: [], action: "window" },
  { name: "reconnect", label: "Reconnect", mac: [], other: [], action: "window" },
];

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

export function catalog(mac: boolean): CatalogEntry[] {
  return DEFINITIONS.map(({ name, label, mac: macKeys, other }) => ({
    name,
    label,
    shortcuts: mac ? macKeys : other,
  }));
}

export function isWindowCommand(name: string): boolean {
  return BY_NAME.get(name)?.action === "window";
}

/// The request `name` sends against `snapshot`, or `null` for a window
/// command, an unknown name, or nothing focused to act on. `strip` is the tab
/// strip's order, for the commands that step along it.
export function requestFor(name: string, snapshot: Snapshot, strip: readonly string[] = []): Request | null {
  const action = BY_NAME.get(name)?.action;
  if (!action || action === "window") return null;
  return action(focusOf(snapshot, strip));
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
