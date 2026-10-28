// Mirrors of the Herdr wire types the Rust bridge forwards (herdr-protocol's
// `wire.rs`, serialized by serde), plus the bridge's own event envelope from
// `src-tauri/src/connection.rs`. Field names stay snake_case: they are Herdr's.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Workspace {
  workspace_id: string;
  active_tab_id: string;
  new_workspace_cwd: string;
  number: number;
  label: string;
  custom_label: boolean;
  branch: string | null;
  git_ahead_behind: [number, number] | null;
  tokens: [string, string][];
  worktree: { key: string; label: string; is_linked_worktree: boolean } | null;
  focused: boolean;
  agent_status: AgentStatus;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  custom_label: boolean;
  zoomed: boolean;
  focused: boolean;
  agent_status: AgentStatus;
}

export interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  label: string | null;
  cwd: string | null;
  foreground_cwd: string | null;
  focused: boolean;
  right_click_passthrough: boolean;
}

export interface Agent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  name: string | null;
  display_agent: string | null;
  agent: string | null;
  title: string | null;
  agent_status: AgentStatus;
  focused: boolean;
}

export interface Snapshot {
  boot_id: string;
  revision: number;
  config_diagnostic: string | null;
  update_available: string | null;
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  agents: Agent[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
  /// DECSCUSR: 0 default, 1-2 block, 3-4 underline, 5-6 bar.
  shape: number;
}

export interface SurfacePane {
  pane_id: string;
  rect: Rect;
  inner_rect: Rect;
  focused: boolean;
  mouse_reporting: boolean;
  alternate_screen_active: boolean;
  pixel_width: number;
  pixel_height: number;
}

export type SplitDirection = "Horizontal" | "Vertical";

export interface Split {
  direction: SplitDirection;
  pos: number;
  area: Rect;
  hit_rect: Rect;
  path: boolean[];
}

/// `[symbol, fg, bg, modifier, skip]`, see `frame.rs`.
export type Cell = [string, number, number, number, boolean];

export interface Row {
  y: number;
  cells: Cell[];
}

export type PopupSize = { Cells: number } | { Percent: number };

export interface Popup {
  terminal_id: string;
  title: string;
  width: PopupSize | null;
  height: PopupSize | null;
  cols: number;
  rows: Row[];
  cursor: Cursor | null;
  mouse_reporting: boolean;
}

export interface FrameUpdate {
  boot_id: string;
  surface_revision: number;
  width: number;
  height: number;
  full: boolean;
  rows: Row[];
  cursor: Cursor | null;
  panes: SurfacePane[];
  splits: Split[];
  popup: Popup | null;
}

export type BridgeEvent =
  | { type: "connected"; server_version: string; methods: string[] }
  | { type: "snapshot"; snapshot: Snapshot }
  | ({ type: "frame" } & FrameUpdate)
  | { type: "response"; request_id: string; response: unknown }
  | { type: "rejected"; request_id: string | null; reason: string }
  | { type: "notify"; title: string; body: string | null }
  | { type: "bell" }
  | { type: "title"; title: string | null }
  | { type: "shell_error"; message: string }
  | { type: "version_mismatch"; outdated: "daemon" | "client"; server_version: string | null }
  | { type: "disconnected"; reason: string };

// Input, in serde's externally tagged JSON form of `ClientPaneInputEvent`.

export type KeyCode =
  | "Backspace" | "Enter" | "Left" | "Right" | "Up" | "Down" | "Home" | "End"
  | "PageUp" | "PageDown" | "Tab" | "BackTab" | "Delete" | "Insert" | "Esc" | "Null"
  | { Char: string }
  | { F: number };

export type MouseButton = "Left" | "Right" | "Middle";

export type MouseKind =
  | { Down: MouseButton }
  | { Up: MouseButton }
  | { Drag: MouseButton }
  | "Moved" | "ScrollUp" | "ScrollDown" | "ScrollLeft" | "ScrollRight";

/// Modifier bits: shift=1, control=2, alt=4.
export const SHIFT = 1;
export const CONTROL = 2;
export const ALT = 4;

export type PaneInputEvent =
  | {
      Key: {
        code: KeyCode;
        modifiers: number;
        kind: "Press" | "Repeat" | "Release";
        repeat_count: number;
        shifted_codepoint: null;
        generated_text: null;
        tracks_release: boolean;
        physical_key_id: null;
        windows_record: null;
      };
    }
  | { TextCommit: string }
  | { Paste: string }
  | {
      Mouse: {
        kind: MouseKind;
        position: { Cell: { column: number; row: number } };
        geometry: null;
        modifiers: number;
        lines: number;
      };
    };

/// What the webview measured, sent on connect and every resize.
export interface Surface {
  cols: number;
  rows: number;
  cell_width_px: number;
  cell_height_px: number;
}
