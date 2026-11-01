import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot, Tab, Workspace } from "../../protocol";
import { sortWorkspaces } from "../workspaceOrder";
import { agentCountsByTab, agentRowName, agentsByWorkspace, agentTitle, attentionCount, attentionRows, cardAgents, cardWantsOpen, effectiveStatus, loopTag, loopTags, needsYouNote, outcomeNeedsYou, seenSnapshot, shownStatus, tabNeedsYou, tabVerifiedDone, unseenDone, verifiedDone, wantsYou, workspaceMarks } from "../attention";

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
    state_change_seq: 1,
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

describe("cardWantsOpen", () => {
  const seen = (done: Agent) => seenSnapshot(snapshot([done]), { [done.pane_id]: done.state_change_seq }).agents;

  it("opens for a blocked agent, a needs-you one and a working one", () => {
    expect(cardWantsOpen([agent("1", "a", "blocked")])).toBe(true);
    expect(cardWantsOpen([agent("1", "a", "working")])).toBe(true);
    expect(cardWantsOpen([agent("1", "a", "idle", { tokens: [["attn_outcome", "you: run it"]] })])).toBe(true);
  });

  it("stays open for an unseen finished agent and closes once it is seen", () => {
    const done = agent("1", "a", "done");
    expect(cardWantsOpen([done])).toBe(true);
    expect(cardWantsOpen(seen(done))).toBe(false);
  });

  it("stays open for a needs-you agent that was marked seen", () => {
    const done = agent("1", "a", "done", { tokens: [["attn_outcome", "you: run it"]] });
    expect(cardWantsOpen(seen(done))).toBe(true);
  });

  it("closes for idle and unknown agents, and with none", () => {
    expect(cardWantsOpen([agent("1", "a", "idle"), agent("2", "a", "unknown")])).toBe(false);
    expect(cardWantsOpen([])).toBe(false);
  });

  it("needs only one agent to want it", () => {
    expect(cardWantsOpen([agent("1", "a", "idle"), agent("2", "a", "working")])).toBe(true);
  });
});

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

describe("cardAgents", () => {
  it("leaves out the idle agents and keeps the rest in order", () => {
    const listed = cardAgents([
      agent("1", "a", "blocked"),
      agent("2", "a", "done"),
      agent("3", "a", "working"),
      agent("4", "a", "idle"),
      agent("5", "a", "unknown"),
    ]);
    expect(listed.map((a) => a.pane_id)).toEqual(["1", "2", "3", "5"]);
  });

  it("is empty when every agent is idle, so the card has nothing to list", () => {
    expect(cardAgents([agent("1", "a", "idle"), agent("2", "a", "idle")])).toEqual([]);
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
  it("names every blocked agent, leaving none out, when asked for all", () => {
    const list = [...["1", "2", "3", "4", "5"].map((id) => agent(id, "a", "blocked")), agent("6", "a", "working")];
    const { rows, more } = attentionRows(list, true);
    expect(rows.map((row) => row.pane_id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(more).toBe(0);
  });

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

describe("verifiedDone", () => {
  const verified = { tokens: [["attn_outcome", "verified"]] as [string, string][] };

  it("needs Git's agreement, not just a finished turn", () => {
    expect(verifiedDone(agent("p", "w", "done"))).toBe(false);
    expect(verifiedDone(agent("p", "w", "done", { tokens: [["attn_outcome", "unverified: 2 uncommitted files here"]] }))).toBe(false);
    expect(verifiedDone(agent("p", "w", "done", verified))).toBe(true);
  });

  it("survives being seen, but not new work", () => {
    expect(verifiedDone(agent("p", "w", "idle", verified))).toBe(true);
    expect(verifiedDone(agent("p", "w", "working", verified))).toBe(false);
    expect(verifiedDone(agent("p", "w", "blocked", verified))).toBe(false);
  });

  it("holds for a tab only when all its agents do", () => {
    expect(tabVerifiedDone([])).toBe(false);
    expect(tabVerifiedDone([agent("a", "w", "done", verified), agent("b", "w", "done")])).toBe(false);
    expect(tabVerifiedDone([agent("a", "w", "done", verified), agent("b", "w", "idle", verified)])).toBe(true);
  });
});

describe("marked seen", () => {
  const verified = { tokens: [["attn_outcome", "verified"]] as [string, string][] };
  const tab = (tab_id: string, workspace_id: string, agent_status: AgentStatus): Tab => ({
    tab_id,
    workspace_id,
    number: 1,
    label: tab_id,
    custom_label: false,
    zoomed: false,
    focused: false,
    agent_status,
  });
  const workspace = (workspace_id: string, agent_status: AgentStatus) =>
    ({ workspace_id, agent_status }) as Workspace;

  it("hides a done agent at the sequence it was marked", () => {
    const done = agent("1", "a", "done", { state_change_seq: 7 });
    expect(effectiveStatus(done, { "1": 7 })).toBe("idle");
    const [shown] = seenSnapshot(snapshot([done]), { "1": 7 }).agents;
    expect(wantsYou(shown)).toBe(false);
    expect(cardAgents([shown])).toEqual([]);
    expect(unseenDone([shown])).toEqual([]);
    expect(workspaceMarks([shown], "done")).toEqual([{ status: "idle", count: 1 }]);
  });

  it("brings the mark back when the sequence moves", () => {
    const again = agent("1", "a", "done", { state_change_seq: 8 });
    expect(effectiveStatus(again, { "1": 7 })).toBe("done");
    expect(seenSnapshot(snapshot([again]), { "1": 7 }).agents[0].agent_status).toBe("done");
    expect(effectiveStatus(agent("2", "a", "done", { state_change_seq: 7 }), { "1": 7 })).toBe("done");
  });

  it("never touches a blocked or working agent, even at a marked sequence", () => {
    const list = [agent("1", "a", "blocked", { state_change_seq: 7 }), agent("2", "a", "working", { state_change_seq: 7 })];
    expect(list.map((a) => effectiveStatus(a, { "1": 7, "2": 7 }))).toEqual(["blocked", "working"]);
    expect(attentionRows(seenSnapshot(snapshot(list), { "1": 7, "2": 7 }).agents).rows).toHaveLength(1);
  });

  it("keeps a verified agent's check", () => {
    const shown = seenSnapshot(snapshot([agent("1", "a", "done", { state_change_seq: 7, ...verified })]), { "1": 7 });
    expect(verifiedDone(shown.agents[0])).toBe(true);
    expect(tabVerifiedDone(shown.agents)).toBe(true);
  });

  it("lowers the Dock count by the agents seen, and no further", () => {
    const list = [
      agent("1", "a", "done", { state_change_seq: 7 }),
      agent("2", "a", "done", { state_change_seq: 9 }),
      agent("3", "a", "blocked"),
    ];
    expect(attentionCount(snapshot(list))).toBe(3);
    expect(attentionCount(seenSnapshot(snapshot(list), { "1": 7 }))).toBe(2);
    expect(attentionCount(seenSnapshot(snapshot(list), { "1": 7, "2": 9 }))).toBe(1);
  });

  it("recomputes the rolled up status of tabs and workspaces, so a seen card drops in the attention sort", () => {
    const base = {
      ...snapshot([
        agent("1", "a", "done", { state_change_seq: 7, tab_id: "t1" }),
        agent("2", "a", "working", { tab_id: "t2" }),
        agent("3", "b", "done", { state_change_seq: 3, tab_id: "t3" }),
        agent("4", "c", "working", { tab_id: "t4" }),
      ]),
      tabs: [tab("t1", "a", "done"), tab("t2", "a", "working"), tab("t3", "b", "done"), tab("t4", "c", "working")],
      workspaces: [workspace("c", "working"), workspace("a", "done"), workspace("b", "done")],
    };
    const order = (shown: Snapshot) => sortWorkspaces(shown.workspaces, "attention", shown.agents).map((w) => w.workspace_id);
    expect(order(base)).toEqual(["a", "b", "c"]);

    const shown = seenSnapshot(base, { "1": 7, "3": 3 });
    expect(shown.tabs.map((t) => t.agent_status)).toEqual(["idle", "working", "idle", "working"]);
    expect(shown.workspaces.map((w) => w.agent_status)).toEqual(["working", "working", "idle"]);
    expect(order(shown)).toEqual(["c", "a", "b"]);
  });

  it("keeps the daemon's status for a workspace with no agents, and a done one with another left unseen", () => {
    const base = {
      ...snapshot([agent("1", "a", "done", { state_change_seq: 7 }), agent("2", "a", "done", { state_change_seq: 8 })]),
      workspaces: [workspace("a", "done"), workspace("empty", "done")],
    };
    expect(seenSnapshot(base, { "1": 7 }).workspaces.map((w) => w.agent_status)).toEqual(["done", "done"]);
  });

  it("hands back the daemon's snapshot untouched when nothing applies", () => {
    const base = snapshot([agent("1", "a", "done", { state_change_seq: 8 })]);
    expect(seenSnapshot(base, {})).toBe(base);
    expect(seenSnapshot(base, { "1": 7 })).toBe(base);
  });

  it("leaves the daemon's snapshot as it was", () => {
    const base = snapshot([agent("1", "a", "done", { state_change_seq: 8 })]);
    expect(seenSnapshot(base, { "1": 8 })).not.toBe(base);
    expect(base.agents[0].agent_status).toBe("done");
  });
});

describe("an outcome that needs you", () => {
  const outcome = (value: string) => ({ tokens: [["attn_outcome", value]] as [string, string][] });
  const you = outcome("you: run deploy.sh prod");

  it("is a resting agent's `you:` token, with what to do after the prefix", () => {
    expect(needsYouNote(agent("p", "w", "done", you))).toBe("run deploy.sh prod");
    expect(outcomeNeedsYou(agent("p", "w", "idle", you))).toBe(true);
    expect(outcomeNeedsYou(agent("p", "w", "idle", { tokens: [["$attn_outcome", "you: x"]] }))).toBe(true);
    expect(outcomeNeedsYou(agent("p", "w", "working", you))).toBe(false);
    expect(outcomeNeedsYou(agent("p", "w", "blocked", you))).toBe(false);
    expect(outcomeNeedsYou(agent("p", "w", "idle"))).toBe(false);
  });

  it("does not take left, unverified, not-started or verified for it", () => {
    for (const value of ["left: the docs", "unverified: 2 uncommitted files here", "not-started: why", "verified", "your turn"]) {
      expect(outcomeNeedsYou(agent("p", "w", "done", outcome(value)))).toBe(false);
      expect(attentionCount(snapshot([agent("p", "w", "idle", outcome(value))]))).toBe(0);
    }
  });

  it("counts in the Dock badge once idle, and only once while done", () => {
    expect(attentionCount(snapshot([agent("1", "a", "idle", you)]))).toBe(1);
    expect(attentionCount(snapshot([agent("1", "a", "done", you)]))).toBe(1);
    expect(wantsYou(agent("1", "a", "idle", you))).toBe(true);
  });

  it("does not fade when seen, and Mark as Seen leaves it", () => {
    const base = snapshot([agent("1", "a", "done", { ...you, state_change_seq: 7 })]);
    const shown = seenSnapshot(base, { "1": 7 });
    expect(shown.agents[0].agent_status).toBe("idle");
    expect(attentionCount(shown)).toBe(1);
    expect(unseenDone(base.agents)).toEqual([]);
  });

  it("ranks and shows with the blocked agents", () => {
    const list = [agent("1", "a", "done"), agent("2", "a", "working"), agent("3", "a", "idle", you), agent("4", "a", "blocked")];
    expect(agentsByWorkspace(snapshot(list)).get("a")?.map((a) => a.pane_id)).toEqual(["3", "4", "1", "2"]);
    expect(shownStatus(list[2])).toBe("blocked");
    expect(workspaceMarks(list, "done")).toEqual([
      { status: "blocked", count: 2 },
      { status: "working", count: 1 },
      { status: "done", count: 1 },
    ]);
    expect(attentionRows(list).rows.map((a) => a.pane_id)).toEqual(["3", "4"]);
    expect(cardAgents([agent("1", "a", "idle"), list[2]])).toEqual([list[2]]);
  });

  it("puts its workspace with the blocked ones, whatever the daemon rolled up", () => {
    const workspaces = [
      { workspace_id: "busy", agent_status: "done" },
      { workspace_id: "waiting", agent_status: "idle" },
    ] as Workspace[];
    const sorted = sortWorkspaces(workspaces, "attention", [agent("1", "waiting", "idle", you)]);
    expect(sorted.map((w) => w.workspace_id)).toEqual(["waiting", "busy"]);
  });

  it("marks a tab if any one agent needs you, with every note", () => {
    expect(tabNeedsYou([agent("1", "a", "working"), agent("2", "a", "idle")])).toBeNull();
    expect(tabNeedsYou([agent("1", "a", "working"), agent("2", "a", "idle", you)])).toBe("run deploy.sh prod");
    expect(tabNeedsYou([agent("1", "a", "idle", you), agent("2", "a", "done", outcome("you: pick one"))])).toBe("run deploy.sh prod; pick one");
    expect(tabNeedsYou([agent("1", "a", "idle", outcome("you:"))])).toBe("");
  });
});
