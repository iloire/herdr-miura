import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot, Tab } from "../../protocol";
import { parseTeam, teamRows } from "../team";

function tab(tab_id: string, workspace_id: string, label: string): Tab {
  return { tab_id, workspace_id, number: 1, label, custom_label: true, zoomed: false, focused: false, agent_status: "idle" };
}

function agent(tab_id: string, agent_status: AgentStatus): Agent {
  return {
    pane_id: `${tab_id}:p`,
    workspace_id: "w1",
    tab_id,
    name: null,
    display_agent: null,
    agent: "claude",
    title: null,
    terminal_title_stripped: null,
    agent_status,
    state_change_seq: 1,
    tokens: [],
    focused: false,
  };
}

function snapshot(tabs: Tab[], agents: Agent[]): Snapshot {
  return {
    boot_id: "boot",
    revision: 1,
    config_diagnostic: null,
    update_available: null,
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    workspaces: [],
    tabs,
    panes: [],
    agents,
  };
}

describe("parseTeam", () => {
  it("reads the members in order, an agent defaulting to its role's name", () => {
    expect(parseTeam('{"members": [{"role": "cto"}, {"role": "qa", "agent": "qa-phones"}]}')).toEqual([
      { role: "cto", agent: "cto" },
      { role: "qa", agent: "qa-phones" },
    ]);
  });

  it("refuses a file it cannot start a team from", () => {
    for (const text of [
      "not json",
      "{}",
      '{"members": []}',
      '{"members": [{"agent": "cto"}]}',
      '{"members": [{"role": "-x"}]}',
      '{"members": [{"role": "a b"}]}',
      '{"members": [{"role": "cto", "agent": "x; rm -rf ~"}]}',
      '{"members": [{"role": "cto"}, {"role": "cto"}]}',
      JSON.stringify({ members: Array.from({ length: 13 }, (_, i) => ({ role: `r${i}` })) }),
    ]) {
      expect(parseTeam(text), text).toHaveProperty("error");
    }
  });
});

describe("teamRows", () => {
  const members = [
    { role: "cto", agent: "cto" },
    { role: "qa", agent: "qa" },
    { role: "frontend", agent: "frontend" },
  ];

  it("finds each role's tab by name in its workspace and takes its most urgent agent", () => {
    const rows = teamRows(
      members,
      "w1",
      snapshot(
        [tab("t1", "w1", "cto"), tab("t2", "w1", "qa"), tab("t3", "w2", "frontend")],
        [agent("t1", "working"), agent("t1", "blocked")],
      ),
    );
    expect(rows.map((row) => [row.member.role, row.state, row.tabId])).toEqual([
      ["cto", "blocked", "t1"],
      ["qa", "shell", "t2"],
      ["frontend", "absent", null],
    ]);
  });

  it("says a member that finished needing you is waiting on you", () => {
    const waiting = { ...agent("t1", "idle"), tokens: [["attn_outcome", "you: run it"]] } as Agent;
    const [cto] = teamRows(members, "w1", snapshot([tab("t1", "w1", "cto")], [waiting]));
    expect(cto.state).toBe("blocked");
  });
});
