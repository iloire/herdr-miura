import { describe, expect, it } from "vitest";
import type { ChangesState, CheckoutChanges } from "../../changes/store";
import type { Agent, AgentStatus, Pane, Snapshot, Tab } from "../../protocol";
import type { SessionUsage } from "../sessionUsage";
import { inLinkedWorktree, paneDirectory, sessionWorktree, sharedCheckout, sharedTitle, tabDirectory, withSessionFolders } from "../sharedCheckout";

const pane = (id: string, cwd: string, over: Partial<Pane> = {}): Pane => ({
  pane_id: id,
  workspace_id: "w",
  tab_id: `t${id}`,
  label: null,
  cwd,
  foreground_cwd: null,
  focused: false,
  right_click_passthrough: false,
  ...over,
});

describe("tabDirectory", () => {
  const tab = { tab_id: "t" } as Tab;
  const of = (...panes: Pane[]) => tabDirectory(tab, { panes } as Snapshot);

  it("takes the tab's focused pane, else its first, and never another tab's", () => {
    const other = pane("x", "/other", { focused: true });
    const first = pane("1", "/first", { tab_id: "t" });
    const second = pane("2", "/second", { tab_id: "t", focused: true });
    expect(of(other, first, second)).toBe("/second");
    expect(of(other, first)).toBe("/first");
    expect(of(other)).toBeNull();
  });
});

const agent = (id: string, status: AgentStatus = "working"): Agent => ({
  pane_id: id,
  workspace_id: "w",
  tab_id: `t${id}`,
  name: null,
  display_agent: "Claude Code",
  agent: "claude",
  title: null,
  terminal_title_stripped: null,
  agent_status: status,
  state_change_seq: 1,
  tokens: [],
  focused: false,
});

const tab = (id: string, label: string): Tab => ({
  tab_id: id,
  workspace_id: "w",
  number: 1,
  label,
  custom_label: false,
  zoomed: false,
  focused: false,
  agent_status: "working",
});

const snapshot = (panes: Pane[], agents: Agent[], tabs: Tab[] = []): Snapshot => ({
  boot_id: "b",
  revision: 1,
  config_diagnostic: null,
  update_available: null,
  focused_workspace_id: "w",
  focused_tab_id: "t1",
  focused_pane_id: "1",
  workspaces: [],
  tabs,
  panes,
  agents,
});

const ready = (path: string | null, directory = "/repo"): ChangesState => ({
  phase: "ready",
  directory,
  checkout: path ? ({ path } as CheckoutChanges) : null,
  at: 0,
});

describe("sharedCheckout", () => {
  it("counts two agents in different subfolders of one checkout as sharing it", () => {
    const panes = [pane("1", "/repo/src"), pane("2", "/repo/docs/deep")];
    const shared = sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready("/repo", "/repo/src"), "/repo/src", []);
    expect(shared?.count).toBe(2);
  });

  it("is null for an agent alone", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo")];
    expect(sharedCheckout(snapshot(panes, [agent("1")]), ready("/repo"), "/repo", [])).toBeNull();
  });

  it("does not take a folder that only starts like the checkout", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo-two")];
    expect(sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready("/repo"), "/repo", [])).toBeNull();
  });

  it("keeps a linked worktree inside the checkout apart from it", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo/wt/one/src")];
    const agents = [agent("1"), agent("2")];
    expect(sharedCheckout(snapshot(panes, agents), ready("/repo"), "/repo", ["/repo/wt/one"])).toBeNull();
  });

  it("keeps .claude/worktrees apart before the list of worktrees names it", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo/.claude/worktrees/new")];
    expect(sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready("/repo"), "/repo", [])).toBeNull();
  });

  it("keeps the main checkout apart from a worktree's", () => {
    const wt = "/repo/.claude/worktrees/one";
    const panes = [pane("1", wt), pane("2", "/repo")];
    expect(sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready(wt, wt), wt, [wt])).toBeNull();
  });

  it("sees two agents inside one linked worktree", () => {
    const wt = "/repo/.claude/worktrees/one";
    const panes = [pane("1", `${wt}/src`), pane("2", wt)];
    expect(sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready(wt, `${wt}/src`), `${wt}/src`, [wt])?.count).toBe(2);
  });

  it("counts working and blocked, not done, idle or unknown", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo")];
    const count = (status: AgentStatus) => sharedCheckout(snapshot(panes, [agent("1"), agent("2", status)]), ready("/repo"), "/repo", [])?.count ?? null;
    expect(count("blocked")).toBe(2);
    expect(count("working")).toBe(2);
    expect(count("idle")).toBeNull();
    expect(count("done")).toBeNull();
    expect(count("unknown")).toBeNull();
  });

  it("goes by the foreground folder before the shell's", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo", { foreground_cwd: "/elsewhere" })];
    expect(sharedCheckout(snapshot(panes, [agent("1"), agent("2")]), ready("/repo"), "/repo", [])).toBeNull();
  });

  it("warns for two others while the focused pane has no agent", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo"), pane("3", "/repo")];
    const shared = sharedCheckout(snapshot(panes, [agent("2"), agent("3")], [tab("t2", "api"), tab("t3", "docs")]), ready("/repo"), "/repo", []);
    expect(shared).toEqual({ count: 2, others: ["api", "docs"] });
  });

  it("names the others, not the focused pane's own agent", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo")];
    const tabs = [tab("t1", "mine"), tab("t2", "theirs")];
    const shared = sharedCheckout(snapshot(panes, [agent("1"), agent("2")], tabs), ready("/repo"), "/repo", []);
    expect(shared?.others).toEqual(["theirs"]);
    expect(sharedTitle(shared!)).toContain("Also here: theirs");
  });

  it("says nothing for another directory's read, or outside Git", () => {
    const panes = [pane("1", "/repo"), pane("2", "/repo")];
    const both = snapshot(panes, [agent("1"), agent("2")]);
    expect(sharedCheckout(both, ready("/repo", "/other"), "/repo", [])).toBeNull();
    expect(sharedCheckout(both, ready(null), "/repo", [])).toBeNull();
    expect(sharedCheckout(both, { phase: "loading", directory: "/repo" }, "/repo", [])).toBeNull();
  });
});

describe("paneDirectory", () => {
  it("prefers the foreground process's folder", () => {
    expect(paneDirectory(pane("1", "/a", { foreground_cwd: "/b" }))).toBe("/b");
    expect(paneDirectory(pane("1", "/a"))).toBe("/a");
    expect(paneDirectory(undefined)).toBeNull();
  });
});

describe("sessionWorktree", () => {
  const worktree = "/repo/.claude/worktrees/x";

  it("finds the worktree a session moved into, from any folder of it", () => {
    expect(sessionWorktree([worktree], "/repo")).toBe(worktree);
    expect(sessionWorktree([`${worktree}/src/app`], "/repo")).toBe(worktree);
    expect(sessionWorktree([worktree], "/repo/src")).toBe(worktree);
  });

  it("looks past a scratch folder", () => {
    expect(sessionWorktree(["/tmp/scratch", worktree, "/repo"], "/repo")).toBe(worktree);
  });

  it("is null once the session has left", () => {
    expect(sessionWorktree(["/repo", worktree], "/repo")).toBeNull();
    expect(sessionWorktree(["/repo/src", worktree], "/repo")).toBeNull();
  });

  it("ignores another repo's worktree and a session that never moved", () => {
    expect(sessionWorktree(["/other/.claude/worktrees/y"], "/repo")).toBeNull();
    expect(sessionWorktree(["/repo"], "/repo")).toBeNull();
    expect(sessionWorktree([], "/repo")).toBeNull();
  });
});

describe("withSessionFolders", () => {
  const session = "0f2736ab-56ae-454c-ad08-fc76c65f788f";
  const claude = { ...agent("1"), tokens: [["claude_session", session]] } as Agent;
  const usage = (cwds: string[]) => new Map([[session, { cwds } as SessionUsage]]);
  const snapshot = { agents: [claude], panes: [pane("1", "/repo"), pane("2", "/repo")] } as unknown as Snapshot;

  it("moves only the session's pane", () => {
    const moved = withSessionFolders(snapshot, usage(["/repo/.claude/worktrees/x"]));
    expect(moved.panes.map(paneDirectory)).toEqual(["/repo/.claude/worktrees/x", "/repo"]);
  });

  it("returns the same snapshot when nothing moved", () => {
    expect(withSessionFolders(snapshot, usage(["/repo"]))).toBe(snapshot);
    expect(withSessionFolders(snapshot, new Map())).toBe(snapshot);
  });
});

describe("inLinkedWorktree", () => {
  it("knows agents' worktrees by their place and others from the list", () => {
    expect(inLinkedWorktree("/repo/.claude/worktrees/x/src", [])).toBe(true);
    expect(inLinkedWorktree("/wt/a/src", ["/wt/a"])).toBe(true);
    expect(inLinkedWorktree("/repo", ["/wt/a"])).toBe(false);
  });
});
