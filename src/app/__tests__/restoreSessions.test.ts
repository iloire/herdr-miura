import { describe, expect, it, vi } from "vitest";
import type { Agent, Pane, Snapshot } from "../../protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { openSessions, restorable } = await import("../restoreSessions");

const pane = (id: string, tab: string, cwd = "/code/app") =>
  ({ pane_id: id, tab_id: tab, workspace_id: "w1", cwd, foreground_cwd: null }) as unknown as Pane;
const agent = (id: string, tab: string, session: string | null) =>
  ({ pane_id: id, tab_id: tab, workspace_id: "w1", tokens: session ? [["claude_session", session]] : [] }) as unknown as Agent;
const snapshot = (panes: Pane[], agents: Agent[]) => ({ panes, agents }) as unknown as Snapshot;
const saved = (session: string, paneId: string, tab: string, cwd = "/code/app") => ({
  session,
  workspace_id: "w1",
  tab_id: tab,
  pane_id: paneId,
  cwd,
});

describe("the record of open sessions", () => {
  it("lists each Claude Code with a session and the pane it is in, in pane order", () => {
    const now = snapshot(
      [pane("w1:p2", "w1:t2"), pane("w1:p1", "w1:t1"), pane("w1:p3", "w1:t3")],
      [agent("w1:p2", "w1:t2", "b"), agent("w1:p1", "w1:t1", "a"), agent("w1:p3", "w1:t3", null)],
    );
    expect(openSessions(now)).toEqual([saved("a", "w1:p1", "w1:t1"), saved("b", "w1:p2", "w1:t2")]);
  });
});

describe("what a restart can resume", () => {
  it("is a saved pane still there, empty, in the same tab and folder", () => {
    const after = snapshot([pane("w1:p1", "w1:t1")], []);
    expect(restorable([saved("a", "w1:p1", "w1:t1")], after)).toEqual([saved("a", "w1:p1", "w1:t1")]);
  });

  it("is not a pane that is gone, moved tab or folder, or has an agent again", () => {
    const after = snapshot(
      [pane("w1:p2", "w1:t9"), pane("w1:p3", "w1:t3", "/elsewhere"), pane("w1:p4", "w1:t4")],
      [agent("w1:p4", "w1:t4", null)],
    );
    const old = [saved("a", "w1:p1", "w1:t1"), saved("b", "w1:p2", "w1:t2"), saved("c", "w1:p3", "w1:t3"), saved("d", "w1:p4", "w1:t4")];
    expect(restorable(old, after)).toEqual([]);
  });

  it("is not a session already open, nor one session twice", () => {
    const after = snapshot([pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2"), pane("w1:p5", "w1:t5")], [agent("w1:p5", "w1:t5", "a")]);
    const old = [saved("a", "w1:p1", "w1:t1"), saved("b", "w1:p2", "w1:t2"), saved("b", "w1:p1", "w1:t1")];
    expect(restorable(old, after)).toEqual([saved("b", "w1:p2", "w1:t2")]);
  });
});
