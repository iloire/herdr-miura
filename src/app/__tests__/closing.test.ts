import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot, Tab } from "../../protocol";
import { focusAfterClose, withoutClosing } from "../closing";

const calls: { command: string; args: Record<string, unknown> }[] = [];
let nextId = 0;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    return command === "request" ? `tauri-${++nextId}` : undefined;
  },
}));

const { Controller } = await import("../controller");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function tab(tab_id: string, workspace_id = "w1", focused = false): Tab {
  return { tab_id, workspace_id, number: 1, label: tab_id, custom_label: false, zoomed: false, focused, agent_status: "idle" };
}

function snapshot(tabs: Tab[]): Snapshot {
  return {
    boot_id: "b",
    revision: 1,
    config_diagnostic: null,
    update_available: null,
    focused_workspace_id: "w1",
    focused_tab_id: tabs.find((t) => t.focused)?.tab_id ?? null,
    focused_pane_id: null,
    workspaces: [],
    tabs,
    panes: tabs.map((t) => ({
      pane_id: `${t.tab_id}:p`,
      workspace_id: t.workspace_id,
      tab_id: t.tab_id,
      label: null,
      cwd: null,
      foreground_cwd: null,
      focused: t.focused,
      right_click_passthrough: false,
    })),
    agents: [],
  };
}

describe("focusAfterClose", () => {
  const tabs = [tab("a"), tab("x", "w2"), tab("b"), tab("c")];

  it("focuses the tab before, in the same workspace", () => {
    expect(focusAfterClose(tabs, tabs[2])?.tab_id).toBe("a");
    expect(focusAfterClose(tabs, tabs[3])?.tab_id).toBe("b");
  });

  it("focuses the next tab when the first closes, and none for the last one left", () => {
    expect(focusAfterClose(tabs, tabs[0])?.tab_id).toBe("b");
    expect(focusAfterClose(tabs, tabs[1])).toBeNull();
  });
});

describe("withoutClosing", () => {
  it("drops the closing tabs and their panes", () => {
    const hidden = withoutClosing(snapshot([tab("a"), tab("b")]), new Set(["b"]));
    expect(hidden.tabs.map((t) => t.tab_id)).toEqual(["a"]);
    expect(hidden.panes.map((p) => p.tab_id)).toEqual(["a"]);
  });
});

describe("closing a tab", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  async function connected(tabs: Tab[]) {
    const controller = new Controller();
    await controller.setSurface({ cols: 80, rows: 24, cell_width_px: 8, cell_height_px: 16 });
    const channel = calls.find((c) => c.command === "connect")?.args.events as { onmessage: (event: unknown) => void };
    channel.onmessage({ type: "snapshot", snapshot: snapshot(tabs) });
    return { controller, emit: channel.onmessage };
  }

  const shown = (controller: InstanceType<typeof Controller>) => controller.getState().snapshot?.tabs.map((t) => t.tab_id);
  const requests = () => calls.filter((c) => c.command === "request").map((c) => [c.args.method, c.args.params]);

  it("hides the tab before the daemon answers, focusing its neighbour first", async () => {
    const { controller, emit } = await connected([tab("a"), tab("b", "w1", true)]);
    controller.request("tab.close", { tab_id: "b" });
    expect(shown(controller)).toEqual(["a"]);
    expect(requests()).toEqual([
      ["tab.focus", { tab_id: "a" }],
      ["tab.close", { tab_id: "b" }],
    ]);

    // The daemon still lists it until the process exits.
    emit({ type: "snapshot", snapshot: snapshot([tab("a", "w1", true), tab("b")]) });
    expect(shown(controller)).toEqual(["a"]);
    emit({ type: "snapshot", snapshot: snapshot([tab("a", "w1", true)]) });
    expect(shown(controller)).toEqual(["a"]);
  });

  it("brings the tab back when the daemon refuses the close", async () => {
    const { controller, emit } = await connected([tab("a"), tab("b")]);
    controller.request("tab.close", { tab_id: "b" });
    await flush();
    const closeId = `tauri-${nextId}`;
    expect(requests()).toEqual([["tab.close", { tab_id: "b" }]]);
    expect(shown(controller)).toEqual(["a"]);
    emit({ type: "response", request_id: closeId, response: { error: { message: "no" } } });
    expect(shown(controller)).toEqual(["a", "b"]);
    expect(controller.getState().notice).toBe("no");
  });
});
