import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Pane, Snapshot, Tab } from "../../protocol";
import { agentCaption, agentName, agentsByWorkspace, attentionCount, blockedCount } from "../attention";

function agent(pane_id: string, workspace_id: string, agent_status: AgentStatus, over: Partial<Agent> = {}): Agent {
  return {
    pane_id,
    workspace_id,
    tab_id: "t",
    name: null,
    display_agent: null,
    agent: "claude",
    title: null,
    agent_status,
    focused: false,
    ...over,
  };
}

function snapshot(agents: Agent[]): Snapshot {
  return {
    boot_id: "boot",
    revision: 1,
    config_diagnostic: null,
    update_available: null,
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    workspaces: [],
    tabs: [],
    panes: [],
    agents,
  };
}

describe("agentsByWorkspace", () => {
  it("groups by workspace and puts what needs you first, keeping the daemon's order within a status", () => {
    const grouped = agentsByWorkspace(
      snapshot([
        agent("1", "a", "idle"),
        agent("2", "a", "working"),
        agent("3", "b", "done"),
        agent("4", "a", "blocked"),
        agent("5", "a", "done"),
        agent("6", "a", "working"),
      ]),
    );
    expect(grouped.get("a")?.map((a) => a.pane_id)).toEqual(["4", "5", "2", "6", "1"]);
    expect(grouped.get("b")?.map((a) => a.pane_id)).toEqual(["3"]);
  });
});

describe("counts", () => {
  const agents = [agent("1", "a", "blocked"), agent("2", "a", "done"), agent("3", "a", "working"), agent("4", "b", "blocked")];

  it("counts only blocked agents as waiting on you", () => {
    expect(blockedCount(agents)).toBe(2);
  });

  it("badges finished and waiting agents, and nothing without a snapshot", () => {
    expect(attentionCount(snapshot(agents))).toBe(3);
    expect(attentionCount(snapshot([agent("1", "a", "idle")]))).toBe(0);
    expect(attentionCount(null)).toBe(0);
  });
});

describe("agentName", () => {
  it("prefers the agent's display name, then the given name, kind, and title", () => {
    expect(agentName(agent("1", "a", "idle", { name: "reviewer", display_agent: "Claude" }))).toBe("Claude");
    expect(agentName(agent("1", "a", "idle", { name: "reviewer" }))).toBe("reviewer");
    expect(agentName(agent("1", "a", "idle", { agent: null, title: "vim" }))).toBe("vim");
    expect(agentName(agent("1", "a", "idle", { agent: null }))).toBe("agent");
  });
});

describe("agentCaption", () => {
  const tab = (tab_id: string, label: string, custom_label = false): Tab => ({
    tab_id,
    workspace_id: "a",
    number: 1,
    label,
    custom_label,
    zoomed: false,
    focused: false,
    agent_status: "idle",
  });
  const pane = (label: string | null): Pane => ({
    pane_id: "1",
    workspace_id: "a",
    tab_id: "t",
    label,
    cwd: null,
    foreground_cwd: null,
    focused: false,
    right_click_passthrough: false,
  });
  const caption = (tabs: Tab[], panes: Pane[], over: Partial<Agent> = {}) => {
    const subject = agent("1", "a", "idle", over);
    return agentCaption(subject, { ...snapshot([subject]), tabs, panes });
  };

  it("names the tab once the workspace has several, or the tab was named", () => {
    expect(caption([tab("t", "Shell loading time"), tab("u", "notes")], [pane("p")])).toBe("Shell loading time");
    expect(caption([tab("t", "review", true)], [pane("p")])).toBe("review");
  });

  it("falls back to the pane's name, then the agent's title", () => {
    expect(caption([tab("t", "1")], [pane("renamed")], { title: "Fix CI" })).toBe("renamed");
    expect(caption([tab("t", "1")], [pane(null)], { title: "Fix CI" })).toBe("Fix CI");
  });

  it("strips terminal controls and drops blanks and repeats of the name", () => {
    expect(caption([tab("t", "1")], [pane(null)], { title: "\u001b[31mred\u202e" })).toBe("[31mred");
    expect(caption([tab("t", "1")], [pane(null)], { title: "   " })).toBeNull();
    expect(caption([tab("t", "1")], [pane(null)], { title: "claude" })).toBeNull();
  });
});
