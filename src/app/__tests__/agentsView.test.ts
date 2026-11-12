import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus } from "../../protocol";
import { loadSidebarView, type PlacedAgent, saveSidebarView, statusSections } from "../agentsView";

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
    expect(loadSidebarView(memory())).toEqual({ view: "workspaces", doneFolded: true });
  });

  it("remembers the view and the fold", () => {
    const storage = memory();
    saveSidebarView({ view: "agents", doneFolded: false }, storage);
    expect(loadSidebarView(storage)).toEqual({ view: "agents", doneFolded: false });
  });

  it("treats a stored value it cannot read as the default", () => {
    expect(loadSidebarView(memory("not json"))).toEqual({ view: "workspaces", doneFolded: true });
    expect(loadSidebarView(memory('{"view":"tabs","doneFolded":1}'))).toEqual({ view: "workspaces", doneFolded: true });
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
