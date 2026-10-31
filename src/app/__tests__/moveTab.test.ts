import { describe, expect, it } from "vitest";
import type { Pane, Snapshot, Tab, Workspace } from "../../protocol";
import { moveChoices, splitName, tabMove } from "../moveTab";

const tab = (tab_id: string, workspace_id: string, extra: Partial<Tab> = {}) =>
  ({ tab_id, workspace_id, label: tab_id, custom_label: false, ...extra }) as Tab;
const pane = (pane_id: string, tab_id: string, extra: Partial<Pane> = {}) =>
  ({ pane_id, tab_id, cwd: null, foreground_cwd: null, focused: false, ...extra }) as Pane;
const workspace = (workspace_id: string) => ({ workspace_id, label: workspace_id, new_workspace_cwd: "/workspace" }) as Workspace;
const snapshot = (workspaces: string[], tabs: Tab[], panes: Pane[] = []) =>
  ({ workspaces: workspaces.map(workspace), tabs, panes }) as unknown as Snapshot;

describe("moveChoices", () => {
  const one = tab("t1", "w1");

  it("offers both with other tabs and other workspaces", () => {
    const { others, canSplit } = moveChoices(one, snapshot(["w1", "w2"], [one, tab("t2", "w1")]));
    expect(others.map((w) => w.workspace_id)).toEqual(["w2"]);
    expect(canSplit).toBe(true);
  });

  it("offers a new workspace with no other workspace to go to", () => {
    const { others, canSplit } = moveChoices(one, snapshot(["w1"], [one, tab("t2", "w1")]));
    expect(others).toEqual([]);
    expect(canSplit).toBe(true);
  });

  it("does not split a workspace's last tab, which would only rename it", () => {
    expect(moveChoices(one, snapshot(["w1", "w2"], [one, tab("t2", "w2")]))).toMatchObject({ canSplit: false });
  });

  it("offers nothing for a last tab with no other workspace", () => {
    expect(moveChoices(one, snapshot(["w1"], [one]))).toEqual({ others: [], canSplit: false });
  });

  it("offers nothing before there is a snapshot", () => {
    expect(moveChoices(one, null)).toEqual({ others: [], canSplit: false });
  });
});

describe("splitName", () => {
  it("is the title the tab shows, named or not", () => {
    expect(splitName(tab("t1", "w1", { label: "npm run dev" }))).toBe("npm run dev");
    expect(splitName(tab("t1", "w1", { label: "API", custom_label: true }))).toBe("API");
  });
});

describe("tabMove", () => {
  it("takes the tab's panes in order and no other's", () => {
    const shot = snapshot(["w1"], [], [pane("p1", "t1"), pane("p2", "t2"), pane("p3", "t1")]);
    expect(tabMove(tab("t1", "w1"), shot).panes).toEqual(["p1", "p3"]);
  });

  it("uses the tab's folder, the focused pane's, not the workspace's", () => {
    const shot = snapshot(["w1"], [], [
      pane("p1", "t1", { cwd: "/first" }),
      pane("p2", "t1", { cwd: "/shell", foreground_cwd: "/project/docs", focused: true }),
    ]);
    expect(tabMove(tab("t1", "w1"), shot).folder).toBe("/project/docs");
  });

  it("keeps the label only of a tab that was named", () => {
    const shot = snapshot(["w1"], []);
    expect(tabMove(tab("t1", "w1", { label: "API", custom_label: true }), shot).label).toBe("API");
    expect(tabMove(tab("t1", "w1", { label: "npm" }), shot).label).toBeNull();
  });
});
