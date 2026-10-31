import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot } from "../../protocol";
import { loadSeen, markSeen, pruneSeen, saveSeen, seenPanes } from "../seen";

const agent = (pane_id: string, agent_status: AgentStatus, state_change_seq: number) =>
  ({ pane_id, agent_status, state_change_seq }) as Agent;

const snapshot = (boot_id: string, panes: string[], agents: Agent[] = []) =>
  ({ boot_id, panes: panes.map((pane_id) => ({ pane_id })), agents }) as Snapshot;

function memory(initial?: string) {
  const items = new Map(initial === undefined ? [] : [["seen-agents", initial]]);
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

describe("markSeen", () => {
  it("records each finished agent's sequence, and no blocked or working one", () => {
    const records = markSeen({}, null, "boot", [agent("1", "done", 7), agent("2", "blocked", 8), agent("3", "working", 9)]);
    expect(seenPanes(records, null, "boot")).toEqual({ "1": 7 });
  });

  it("adds to what the boot already has and replaces a past boot's", () => {
    const first = markSeen({}, null, "boot", [agent("1", "done", 7)]);
    expect(seenPanes(markSeen(first, null, "boot", [agent("2", "done", 8)]), null, "boot")).toEqual({ "1": 7, "2": 8 });
    expect(seenPanes(markSeen(first, null, "next", [agent("2", "done", 8)]), null, "next")).toEqual({ "2": 8 });
  });
});

describe("seenPanes", () => {
  it("reads nothing from another boot, so an old sequence cannot match a new agent", () => {
    expect(seenPanes(markSeen({}, null, "boot", [agent("1", "done", 7)]), null, "next")).toEqual({});
  });

  it("keeps hosts apart, even for the same pane and boot ids", () => {
    const records = markSeen({}, "mini", "boot", [agent("1", "done", 7)]);
    expect(seenPanes(records, null, "boot")).toEqual({});
    expect(seenPanes(records, "mini", "boot")).toEqual({ "1": 7 });
  });
});

describe("pruneSeen", () => {
  const records = markSeen({}, null, "boot", [agent("1", "done", 7), agent("2", "done", 8)]);

  it("drops panes that are gone", () => {
    expect(seenPanes(pruneSeen(records, null, snapshot("boot", ["1"])), null, "boot")).toEqual({ "1": 7 });
  });

  it("keeps a pane hidden by a closing tab while its agent is listed", () => {
    expect(pruneSeen(records, null, snapshot("boot", ["1"], [agent("2", "done", 8)]))).toBe(records);
  });

  it("drops a past boot's record whole", () => {
    expect(pruneSeen(records, null, snapshot("next", ["1", "2"]))).toEqual({});
  });

  it("leaves another host's record alone and returns the same object when nothing goes", () => {
    const both = markSeen(records, "mini", "far", [agent("9", "done", 1)]);
    expect(pruneSeen(both, "mini", snapshot("far", ["9"]))).toBe(both);
    expect(seenPanes(pruneSeen(both, "mini", snapshot("far", [])), null, "boot")).toEqual({ "1": 7, "2": 8 });
  });
});

describe("storage", () => {
  it("round trips, and a bad or missing value reads as nothing seen", () => {
    const storage = memory();
    const records = markSeen({}, null, "boot", [agent("1", "done", 7)]);
    saveSeen(records, storage);
    expect(loadSeen(storage)).toEqual(records);
    expect(loadSeen(memory("not json"))).toEqual({});
    expect(loadSeen(memory())).toEqual({});
  });
});
