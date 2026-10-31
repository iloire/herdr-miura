import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStatus, Snapshot, Tab } from "../../protocol";
import { closeAsk, focusAfterClose, withoutClosing } from "../closing";
import { DEFAULT_SETTINGS } from "../settings";

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

function agent(tab_id: string, agent_status: AgentStatus, extra: Partial<Agent> = {}): Agent {
  return {
    pane_id: `${tab_id}:p`,
    workspace_id: "w1",
    tab_id,
    name: null,
    display_agent: "Claude",
    agent: "claude",
    title: null,
    terminal_title_stripped: null,
    agent_status,
    state_change_seq: 0,
    tokens: [],
    focused: false,
    ...extra,
  };
}

function snapshot(tabs: Tab[], agents: Agent[] = []): Snapshot {
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
    agents,
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

describe("closeAsk", () => {
  const onTab = (...agents: Agent[]) => closeAsk(snapshot([tab("a"), tab("b")], agents), "tab.close", { tab_id: "a" });

  it("asks for an agent that would stop mid-task", () => {
    for (const status of ["working", "blocked"] as const) {
      expect(onTab(agent("a", status))).toEqual({
        method: "tab.close",
        params: { tab_id: "a" },
        name: "a",
        kind: "Tab",
        agents: ["Claude"],
      });
    }
  });

  it("asks for an idle agent that is looping, as it only rests between ticks", () => {
    expect(onTab(agent("a", "idle", { tokens: [["attn_loop", "↻ loop 14:32"]] }))?.agents).toEqual(["Claude"]);
  });

  it("does not ask for an idle, done or unknown agent, another tab's, or none", () => {
    for (const status of ["idle", "done", "unknown"] as const) expect(onTab(agent("a", status))).toBeNull();
    expect(onTab(agent("b", "working"))).toBeNull();
    expect(onTab()).toBeNull();
  });

  it("names only the agents it would stop, with fallbacks", () => {
    const ask = onTab(
      agent("a", "working", { pane_id: "1", display_agent: null, agent: "codex" }),
      agent("a", "blocked", { pane_id: "2", display_agent: null, agent: null }),
      agent("a", "idle", { pane_id: "3" }),
    );
    expect(ask?.agents).toEqual(["codex", "An agent"]);
  });

  it("does not ask for a tab the snapshot no longer lists", () => {
    expect(closeAsk(snapshot([tab("b")], [agent("a", "working")]), "tab.close", { tab_id: "a" })).toBeNull();
  });

  it("counts only the pane's own agent for pane.close", () => {
    const tabs = [tab("a")];
    const agents = [agent("a", "working", { pane_id: "worker" }), agent("a", "idle", { pane_id: "rester" })];
    expect(closeAsk(snapshot(tabs, agents), "pane.close", { pane_id: "worker" })).toEqual({
      method: "pane.close",
      params: { pane_id: "worker" },
      name: "this pane",
      kind: "Pane",
      agents: ["Claude"],
    });
    expect(closeAsk(snapshot(tabs, agents), "pane.close", { pane_id: "rester" })).toBeNull();
    expect(closeAsk(snapshot(tabs, agents), "pane.close", { pane_id: "shell" })).toBeNull();
  });

  it("leaves other requests alone", () => {
    expect(closeAsk(snapshot([tab("a")], [agent("a", "working")]), "pane.clear", { pane_id: "a:p" })).toBeNull();
  });
});

describe("closing a tab", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  async function connected(tabs: Tab[], agents: Agent[] = []) {
    const controller = new Controller();
    await controller.setSurface({ cols: 80, rows: 24, cell_width_px: 8, cell_height_px: 16 });
    const channel = calls.find((c) => c.command === "connect")?.args.events as { onmessage: (event: unknown) => void };
    channel.onmessage({ type: "snapshot", snapshot: snapshot(tabs, agents) });
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

  describe("with an agent at work", () => {
    const tabs = () => [tab("a"), tab("b", "w1", true)];
    const working = [agent("b", "working")];

    it("holds the close, sending nothing and leaving the tab shown", async () => {
      const { controller } = await connected(tabs(), working);
      controller.request("tab.close", { tab_id: "b" });
      await flush();
      expect(requests()).toEqual([]);
      expect(shown(controller)).toEqual(["a", "b"]);
      expect(controller.getState().closeAsk?.kind).toBe("Tab");
    });

    it("sends nothing once cancelled, and hands typing back", async () => {
      const { controller } = await connected(tabs(), working);
      const focusTerminal = vi.fn();
      controller.focusTerminal = focusTerminal;
      controller.request("tab.close", { tab_id: "b" });
      controller.answerClose(false);
      await flush();
      expect(controller.getState().closeAsk).toBeNull();
      expect(requests()).toEqual([]);
      expect(shown(controller)).toEqual(["a", "b"]);
      expect(focusTerminal).toHaveBeenCalledOnce();
    });

    it("closes through closeTab once confirmed: neighbour focused, tab hidden", async () => {
      const { controller } = await connected(tabs(), working);
      controller.request("tab.close", { tab_id: "b" });
      controller.answerClose(true);
      expect(controller.getState().closeAsk).toBeNull();
      expect(shown(controller)).toEqual(["a"]);
      expect(requests()).toEqual([
        ["tab.focus", { tab_id: "a" }],
        ["tab.close", { tab_id: "b" }],
      ]);
    });

    it("holds pane.close too, then sends it", async () => {
      const { controller } = await connected(tabs(), working);
      controller.request("pane.close", { pane_id: "b:p" });
      await flush();
      expect(requests()).toEqual([]);
      expect(controller.getState().closeAsk?.kind).toBe("Pane");
      controller.answerClose(true);
      await flush();
      expect(requests()).toEqual([["pane.close", { pane_id: "b:p" }]]);
    });

    it("closes at once with the setting off", async () => {
      vi.stubGlobal("document", { documentElement: { style: { setProperty: () => {} } } });
      const { controller } = await connected(tabs(), working);
      controller.applySettings({ ...DEFAULT_SETTINGS, confirmCloseTab: false });
      controller.request("tab.close", { tab_id: "b" });
      expect(controller.getState().closeAsk).toBeNull();
      expect(shown(controller)).toEqual(["a"]);
      vi.unstubAllGlobals();
    });

    it("ignores shortcuts while asking, so none takes the focus from the dialog", async () => {
      const { controller } = await connected(tabs(), working);
      controller.loadCatalog();
      const toggleSidebar = { key: "B", code: "KeyB", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, repeat: false };
      const sidebar = controller.getState().sidebar;
      controller.request("tab.close", { tab_id: "b" });
      expect(controller.shortcut(toggleSidebar)).toBe(true);
      expect(controller.getState().sidebar).toBe(sidebar);
      controller.answerClose(false);
      expect(controller.shortcut(toggleSidebar)).toBe(true);
      expect(controller.getState().sidebar).toBe(!sidebar);
    });

    it("drops the question on a new connection, where its IDs mean nothing", async () => {
      const { controller } = await connected(tabs(), working);
      controller.request("tab.close", { tab_id: "b" });
      await controller.connect();
      expect(controller.getState().closeAsk).toBeNull();
    });
  });
});
