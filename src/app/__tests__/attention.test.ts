import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot, Tab } from "../../protocol";
import { agentCountsByTab, agentRowName, agentsByWorkspace, agentTitle, attentionCount, attentionRows, loopTag, loopTags, workspaceMarks } from "../attention";

function agent(pane_id: string, workspace_id: string, agent_status: AgentStatus, over: Partial<Agent> = {}): Agent {
  return {
    pane_id,
    workspace_id,
    tab_id: "t",
    name: null,
    display_agent: null,
    agent: "claude",
    title: null,
    terminal_title_stripped: null,
    agent_status,
    tokens: [],
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

describe("agentTitle", () => {
  const title = (over: Partial<Agent>) => agentTitle(agent("1", "a", "idle", over));

  it("takes the terminal's stripped title, which is all Claude Code gives", () => {
    expect(title({ terminal_title_stripped: "Tab strip agent title" })).toBe("Tab strip agent title");
  });

  it("prefers a reported title, unless it is blank", () => {
    expect(title({ title: "Reported", terminal_title_stripped: "Terminal" })).toBe("Reported");
    expect(title({ title: "  ", terminal_title_stripped: "Terminal" })).toBe("Terminal");
  });

  it("shows nothing for a missing or blank title", () => {
    expect(title({})).toBeNull();
    expect(title({ terminal_title_stripped: "   " })).toBeNull();
  });

  it("shows nothing for a title that repeats the agent, whatever its case", () => {
    expect(title({ terminal_title_stripped: "claude" })).toBeNull();
    expect(title({ terminal_title_stripped: "Claude Code" })).toBeNull();
    expect(title({ agent: "pi", display_agent: "Pi Agent", terminal_title_stripped: "pi agent" })).toBeNull();
    expect(title({ name: "q46", terminal_title_stripped: "Q46" })).toBeNull();
  });

  it("keeps a title that only starts with the agent's name", () => {
    expect(title({ terminal_title_stripped: "Claude Code hooks" })).toBe("Claude Code hooks");
  });

  it("drops the controls and bidi overrides a terminal title can carry", () => {
    expect(title({ terminal_title_stripped: "a\u202Eb\u0007c" })).toBe("abc");
  });
});

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

  it("marks every live status, so a finished agent does not hide a working one", () => {
    expect(workspaceMarks(agents, "done")).toEqual([
      { status: "blocked", count: 2 },
      { status: "working", count: 1 },
      { status: "done", count: 1 },
    ]);
    expect(workspaceMarks([agent("1", "a", "done"), agent("2", "a", "working")], "done")).toEqual([
      { status: "working", count: 1 },
      { status: "done", count: 1 },
    ]);
  });

  it("shows idle only when nothing is live, and the daemon's status without agents", () => {
    expect(workspaceMarks([agent("1", "a", "idle"), agent("2", "a", "working")], "working")).toEqual([
      { status: "working", count: 1 },
    ]);
    expect(workspaceMarks([agent("1", "a", "idle")], "idle")).toEqual([{ status: "idle", count: 1 }]);
    expect(workspaceMarks([], "unknown")).toEqual([{ status: "unknown", count: 0 }]);
  });

  it("badges finished and waiting agents, and nothing without a snapshot", () => {
    expect(attentionCount(snapshot(agents))).toBe(3);
    expect(attentionCount(snapshot([agent("1", "a", "idle")]))).toBe(0);
    expect(attentionCount(null)).toBe(0);
  });
});

describe("agentCountsByTab", () => {
  it("counts the agents in each tab, across workspaces", () => {
    const counts = agentCountsByTab(
      snapshot([
        agent("1", "a", "working", { tab_id: "t1" }),
        agent("2", "a", "done", { tab_id: "t1" }),
        agent("3", "a", "idle", { tab_id: "t2" }),
        agent("4", "b", "blocked", { tab_id: "t3" }),
        agent("5", "b", "working", { tab_id: "t3" }),
        agent("6", "b", "working", { tab_id: "t3" }),
      ]),
    );
    expect(Object.fromEntries(counts)).toEqual({ t1: 2, t2: 1, t3: 3 });
  });
});

describe("loopTag", () => {
  it("reads the loop tag herdr-attention reports, with or without the $ the config writes", () => {
    expect(loopTag(agent("1", "a", "done", { tokens: [["attn_done", "✓ done"], ["attn_loop", "↻ loop 14:32"]] }))).toBe(
      "↻ loop 14:32",
    );
    expect(loopTag(agent("1", "a", "done", { tokens: [["$attn_loop", "↻ loop"]] }))).toBe("↻ loop");
    expect(loopTag(agent("1", "a", "done", { tokens: [["attn_done", "✓ done"]] }))).toBeNull();
  });

  it("collects the loops among a tab's or workspace's agents", () => {
    const agents = [
      agent("1", "a", "idle", { tokens: [["attn_loop", "↻ loop 09:05"]] }),
      agent("2", "a", "working"),
      agent("3", "a", "done", { tokens: [["attn_loop", "↻ loop"]] }),
    ];
    expect(loopTags(agents)).toEqual(["↻ loop 09:05", "↻ loop"]);
    expect(loopTags([agent("2", "a", "working")])).toEqual([]);
  });
});

describe("agentRowName", () => {
  const tab = (tab_id: string, label: string): Tab => ({
    tab_id,
    workspace_id: "a",
    number: 1,
    label,
    custom_label: false,
    zoomed: false,
    focused: false,
    agent_status: "idle",
  });
  const tabs = [tab("t1", "Fix the build"), tab("t2", "Review")];
  const counts = new Map([
    ["t1", 1],
    ["t2", 2],
  ]);

  it("is the agent's tab, as the tab strip names it", () => {
    expect(agentRowName(agent("1", "a", "idle", { tab_id: "t1", name: "q46" }), tabs, counts)).toBe("Fix the build");
  });

  it("tells apart agents that share a tab", () => {
    expect(agentRowName(agent("1", "a", "idle", { tab_id: "t2", name: "reviewer" }), tabs, counts)).toBe("Review · reviewer");
    expect(agentRowName(agent("2", "a", "idle", { tab_id: "t2" }), tabs, counts)).toBe("Review · claude");
  });

  it("falls back to the agent's own name without a tab", () => {
    expect(agentRowName(agent("1", "a", "idle", { tab_id: "gone", display_agent: "Claude" }), tabs, counts)).toBe("Claude");
    expect(agentRowName(agent("1", "a", "idle", { tab_id: "gone", agent: null }), tabs, counts)).toBe("agent");
  });
});

describe("attentionRows", () => {
  const ids = (agents: Agent[]) => agents.map((a) => a.pane_id);

  it("names only the blocked agents, in order", () => {
    const { rows, more } = attentionRows([
      agent("1", "a", "blocked"),
      agent("2", "a", "done"),
      agent("3", "a", "working"),
      agent("4", "a", "idle"),
      agent("5", "a", "unknown"),
      agent("6", "a", "blocked"),
    ]);
    expect(ids(rows)).toEqual(["1", "6"]);
    expect(more).toBe(0);
  });

  it("shows nothing when no agent is blocked", () => {
    expect(attentionRows([agent("1", "a", "working")])).toEqual({ rows: [], more: 0 });
    expect(attentionRows([])).toEqual({ rows: [], more: 0 });
  });

  it("gives done agents no rows, however many there are", () => {
    expect(attentionRows(["1", "2", "3", "4"].map((id) => agent(id, "a", "done")))).toEqual({ rows: [], more: 0 });
  });

  it("names three and counts the rest", () => {
    const { rows, more } = attentionRows(["1", "2", "3", "4", "5"].map((id) => agent(id, "a", "blocked")));
    expect(ids(rows)).toEqual(["1", "2", "3"]);
    expect(more).toBe(2);
  });

  it("does not count agents that are not blocked among the rest", () => {
    const blocked = ["1", "2", "3"].map((id) => agent(id, "a", "blocked"));
    expect(attentionRows([...blocked, agent("4", "a", "working")]).more).toBe(0);
    expect(attentionRows([...blocked, agent("4", "a", "done"), agent("5", "a", "done")]).more).toBe(0);
  });
});
