import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus } from "../../protocol";
import { busyPanes, loadSidebarView, type PlacedAgent, RECENT_MAX, RECENT_MS, saveSidebarView, stampIdle, statusSections } from "../agentsView";

function memory(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

function placed(pane_id: string, agent_status: AgentStatus, over: Partial<Agent> = {}): PlacedAgent {
  return {
    workspaceId: "w",
    label: "work",
    hue: "red",
    agent: {
      pane_id,
      workspace_id: "w",
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
    },
  };
}

const panes = (list: PlacedAgent[]) => list.map((entry) => entry.agent.pane_id);

describe("sidebar view", () => {
  it("starts on the workspaces with finished agents folded", () => {
    expect(loadSidebarView(memory())).toEqual({ view: "workspaces", doneFolded: true, recentFolded: false });
  });

  it("remembers the view and the fold", () => {
    const storage = memory();
    saveSidebarView({ view: "agents", doneFolded: false, recentFolded: true }, storage);
    expect(loadSidebarView(storage)).toEqual({ view: "agents", doneFolded: false, recentFolded: true });
  });

  it("treats a stored value it cannot read as the default", () => {
    expect(loadSidebarView(memory("not json"))).toEqual({ view: "workspaces", doneFolded: true, recentFolded: false });
    expect(loadSidebarView(memory('{"view":"tabs","doneFolded":1}'))).toEqual({ view: "workspaces", doneFolded: true, recentFolded: false });
  });
});

describe("status sections", () => {
  it("sorts agents by what they want of you, keeping their order", () => {
    const sections = statusSections([
      placed("a", "done"),
      placed("b", "working"),
      placed("c", "blocked"),
      placed("d", "idle"),
      placed("e", "done"),
      placed("f", "unknown"),
    ]);
    expect(panes(sections.needsYou)).toEqual(["c"]);
    expect(panes(sections.working)).toEqual(["b", "f"]);
    expect(panes(sections.done)).toEqual(["a", "e"]);
  });

  it("puts a finished agent that asked for you with the ones waiting on you", () => {
    const ask = { tokens: [["attn_outcome", "you: run it"]] as [string, string][] };
    const sections = statusSections([placed("a", "done", ask), placed("b", "idle", ask)]);
    expect(panes(sections.needsYou)).toEqual(["a", "b"]);
    expect(sections.done).toEqual([]);
  });
});

describe("recent agents", () => {
  const agent = (pane: string, status: AgentStatus) => placed(pane, status).agent;

  it("lists idle agents that went idle lately, latest first", () => {
    const now = RECENT_MS * 2;
    const sections = statusSections(
      [placed("a", "idle"), placed("b", "idle"), placed("c", "idle"), placed("d", "done")],
      { a: now - 1000, b: now - 10, c: now - RECENT_MS, d: now },
      now,
    );
    expect(panes(sections.recent)).toEqual(["b", "a"]);
    expect(panes(sections.done)).toEqual(["d"]);
  });

  it("lists a few at most", () => {
    const many = Array.from({ length: RECENT_MAX + 3 }, (_, i) => placed(`p${i}`, "idle"));
    const since = Object.fromEntries(many.map((entry, i) => [entry.agent.pane_id, i]));
    expect(statusSections(many, since, 100).recent).toHaveLength(RECENT_MAX);
  });

  it("stamps an agent that was busy and is idle now", () => {
    const busy = busyPanes([agent("a", "done"), agent("b", "working"), agent("c", "idle")]);
    const next = stampIdle({}, "boot", busy, [agent("a", "idle"), agent("b", "working"), agent("c", "idle")], 50);
    expect(next).toEqual({ boot: { a: 50 } });
  });

  it("returns the same record when nothing goes idle", () => {
    const records = { boot: { a: 40 } };
    expect(stampIdle(records, "boot", new Set(), [agent("a", "idle")], 50)).toBe(records);
  });

  it("drops stale stamps and gone panes of this boot, keeping other boots'", () => {
    const records = { boot: { a: 40, gone: 40, old: 0 }, other: { x: 45 } };
    const next = stampIdle(records, "boot", new Set(), [agent("a", "idle"), agent("old", "idle")], RECENT_MS + 1);
    expect(next).toEqual({ boot: { a: 40 }, other: { x: 45 } });
  });
});
