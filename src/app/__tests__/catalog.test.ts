import { describe, expect, it } from "vitest";
import type { Pane, Snapshot, Tab, Workspace } from "../../protocol";
import { parseShortcut } from "../../terminal/keys";
import { catalog, isWindowCommand, requestFor } from "../catalog";

function workspace(workspace_id: string): Workspace {
  return {
    workspace_id,
    active_tab_id: "",
    new_workspace_cwd: "/",
    number: 1,
    label: workspace_id,
    custom_label: false,
    branch: null,
    git_ahead_behind: null,
    tokens: [],
    worktree: null,
    focused: false,
    agent_status: "idle",
  };
}

function tab(tab_id: string, workspace_id: string): Tab {
  return { tab_id, workspace_id, number: 1, label: tab_id, custom_label: false, zoomed: false, focused: false, agent_status: "idle" };
}

function pane(pane_id: string, tab_id: string, workspace_id: string): Pane {
  return {
    pane_id,
    workspace_id,
    tab_id,
    label: null,
    cwd: null,
    foreground_cwd: null,
    focused: false,
    right_click_passthrough: false,
  };
}

/// Workspace `w` with tabs t1–t3, t1 holding panes p1 and p2; `x` elsewhere.
function snapshot(focus: Partial<Pick<Snapshot, "focused_workspace_id" | "focused_tab_id" | "focused_pane_id">> = {}): Snapshot {
  return {
    boot_id: "boot",
    revision: 1,
    config_diagnostic: null,
    update_available: null,
    focused_workspace_id: "w",
    focused_tab_id: "t1",
    focused_pane_id: "p1",
    ...focus,
    workspaces: [workspace("w"), workspace("x")],
    tabs: [tab("t1", "w"), tab("x1", "x"), tab("t2", "w"), tab("t3", "w")],
    panes: [pane("p1", "t1", "w"), pane("p2", "t1", "w"), pane("q1", "x1", "x")],
    agents: [],
  };
}

describe("catalog", () => {
  it("names each command once, with shortcuts that parse on both platforms", () => {
    for (const mac of [true, false]) {
      const entries = catalog(mac);
      expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
      for (const shortcut of entries.flatMap((e) => e.shortcuts)) expect(parseShortcut(shortcut), shortcut).not.toBeNull();
    }
  });

  it("keeps herdr-gpui's keys where muscle memory expects them", () => {
    const keys = (mac: boolean, name: string) => catalog(mac).find((e) => e.name === name)?.shortcuts;
    expect(keys(true, "split_right")).toEqual(["cmd-d"]);
    expect(keys(false, "split_right")).toEqual(["ctrl-shift-d"]);
    expect(keys(true, "focus_tab_3")).toEqual(["cmd-3"]);
  });

  it("leaves window commands to the controller", () => {
    expect(isWindowCommand("toggle_sidebar")).toBe(true);
    expect(isWindowCommand("split_right")).toBe(false);
    expect(requestFor("toggle_sidebar", snapshot())).toBeNull();
    expect(requestFor("no_such_command", snapshot())).toBeNull();
  });
});

describe("requestFor", () => {
  it("creates a workspace from the focused one, or a first one from none", () => {
    expect(requestFor("new_workspace", snapshot())).toEqual({
      method: "workspace.create",
      params: { focus: true, source_workspace_id: "w" },
    });
    const empty = snapshot({ focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null });
    expect(requestFor("new_workspace", empty)).toEqual({ method: "workspace.create", params: { focus: true } });
  });

  it("splits and closes the focused pane", () => {
    expect(requestFor("split_down", snapshot())).toEqual({
      method: "pane.split",
      params: { target_pane_id: "p1", direction: "down", focus: true },
    });
    expect(requestFor("focus_left", snapshot())).toEqual({
      method: "pane.focus_direction",
      params: { pane_id: "p1", direction: "left" },
    });
    expect(requestFor("close_tab", snapshot())).toEqual({ method: "tab.close", params: { tab_id: "t1" } });
  });

  it("steps through the focused workspace's tabs and panes, wrapping at the ends", () => {
    expect(requestFor("previous_tab", snapshot())?.params).toEqual({ tab_id: "t3" });
    expect(requestFor("next_tab", snapshot({ focused_tab_id: "t3", focused_pane_id: null }))?.params).toEqual({ tab_id: "t1" });
    expect(requestFor("next_pane", snapshot({ focused_pane_id: "p2" }))?.params).toEqual({ pane_id: "p1" });
  });

  it("moves a tab as Herdr's TUI does, wrapping from either end", () => {
    const move = (name: string, focused_tab_id: string) => requestFor(name, snapshot({ focused_tab_id, focused_pane_id: null }))?.params;
    expect(move("move_tab_next", "t1")).toEqual({ tab_id: "t1", insert_index: 2 });
    expect(move("move_tab_next", "t3")).toEqual({ tab_id: "t3", insert_index: 0 });
    expect(move("move_tab_previous", "t1")).toEqual({ tab_id: "t1", insert_index: 3 });
  });

  it("focuses a tab by its place in the strip, not its number", () => {
    expect(requestFor("focus_tab_2", snapshot())?.params).toEqual({ tab_id: "t2" });
    expect(requestFor("focus_tab_9", snapshot())).toBeNull();
  });

  it("acts on nothing when the focused pane belongs to another tab", () => {
    const stale = snapshot({ focused_pane_id: "q1" });
    expect(requestFor("close_pane", stale)).toBeNull();
    expect(requestFor("split_right", stale)).toBeNull();
  });
});
