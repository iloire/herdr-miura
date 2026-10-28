import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot } from "../../protocol";
import { agentsByWorkspace, attentionCount, blockedCount } from "../attention";

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
