import { describe, expect, it, vi } from "vitest";
import type { Agent, Snapshot } from "../../protocol";

const invoke = vi.hoisted(() => vi.fn<(command: string, args?: unknown) => Promise<unknown>>());
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke,
}));

const { Controller } = await import("../controller");
const { byDay, dayOf, isActive, latestOutcomes, movedHome, outcomeBadge, placeOf, reopenTarget, sessionFolders, sessionState, sessionTabs } = await import("../recentSessions");
import type { RecentSession } from "../recentSessions";
import type { Outcome } from "../ledger";

function session(id: string, over: Partial<RecentSession> = {}): RecentSession {
  return {
    id,
    title: "A title",
    name: null,
    starred: false,
    prompt: "a prompt",
    first_prompt: null,
    commits: [],
    branch: "main",
    folder: "/code/app",
    opens_in: "/code/app",
    updated_at: 100,
    queue: false,
    running: false,
    ...over,
  };
}

const agent = (session: string | null, tab: string) =>
  ({ tab_id: tab, tokens: session ? [["claude_session", session]] : [] }) as unknown as Agent;
const snapshot = (agents: Agent[]) => ({ agents }) as unknown as Snapshot;
const none = new Set<string>();
const noTabs = new Map<string, string>();

describe("a session's state", () => {
  it("is its tab first, even though a tab's session runs too", () => {
    const tabs = sessionTabs(snapshot([agent("a", "w1:t1"), agent(null, "w1:t2")]));
    expect(sessionState(session("a", { running: true }), tabs, none)).toEqual({ kind: "open", tabId: "w1:t1" });
  });

  it("looks in every workspace: the snapshot's agents are not the focused one's", () => {
    expect(sessionTabs(snapshot([agent("a", "w2:t9")])).get("a")).toBe("w2:t9");
  });

  it("is opening while its tab is on the way, so no second one starts", () => {
    expect(sessionState(session("a"), noTabs, new Set(["a"])).kind).toBe("opening");
  });

  it("is elsewhere when something outside Herdr runs it", () => {
    expect(sessionState(session("a", { running: true }), noTabs, none).kind).toBe("elsewhere");
  });

  it("is gone with nowhere to open, and closed otherwise", () => {
    expect(sessionState(session("a", { opens_in: null }), noTabs, none).kind).toBe("gone");
    expect(sessionState(session("a"), noTabs, none).kind).toBe("closed");
  });
});

describe("Active and History", () => {
  it("counts a session a Claude Code has, in a tab, on its way or elsewhere, as active", () => {
    expect(isActive({ kind: "open", tabId: "w1:t1" })).toBe(true);
    expect(isActive({ kind: "opening" })).toBe(true);
    expect(isActive({ kind: "elsewhere" })).toBe(true);
  });

  it("files the rest under history, even with its folder gone", () => {
    expect(isActive({ kind: "closed" })).toBe(false);
    expect(isActive({ kind: "gone" })).toBe(false);
  });
});

describe("a removed worktree's session", () => {
  it("counts as moved home only when it opens elsewhere", () => {
    expect(movedHome(session("a", { folder: "/code/app/.claude/worktrees/x" }))).toBe(true);
    expect(movedHome(session("a"))).toBe(false);
    expect(movedHome(session("a", { opens_in: null }))).toBe(false);
  });
});

describe("what Reopen Closed Session picks", () => {
  it("takes the newest closed session, passing over open and running ones", () => {
    const list = [session("open"), session("terminal", { running: true }), session("closed"), session("older")];
    const tabs = new Map([["open", "w1:t1"]]);
    expect(reopenTarget(list, tabs, none)?.id).toBe("closed");
  });

  it("passes over queue runs, landed worktrees and folders that are gone", () => {
    const list = [
      session("queued", { queue: true }),
      session("landed", { folder: "/code/app/.claude/worktrees/x" }),
      session("gone", { opens_in: null }),
      session("mine"),
    ];
    expect(reopenTarget(list, noTabs, none)?.id).toBe("mine");
  });

  it("goes one further back while the newest is on its way", () => {
    expect(reopenTarget([session("a"), session("b")], noTabs, new Set(["a"]))?.id).toBe("b");
  });

  it("finds nothing when nothing is closed", () => {
    expect(reopenTarget([session("a", { running: true })], noTabs, none)).toBeNull();
  });
});

describe("a workspace's folders", () => {
  it("are its root and worktrees", () => {
    expect(sessionFolders("/code/app", [{ path: "/code/app-wt" }])).toEqual(["/code/app", "/code/app-wt"]);
    expect(sessionFolders(null, [])).toBeNull();
  });
});

describe("the controller", () => {
  const answers = (list: RecentSession[]) =>
    invoke.mockImplementation(async (command) => {
      if (command === "recent_sessions") return list;
      if (command === "session_resume") return { ready: true };
      return undefined;
    });
  const resumed = () => invoke.mock.calls.filter(([command]) => command === "session_resume").map(([, args]) => args);
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  it("runs the reopen command through what App set", () => {
    const controller = new Controller();
    const reopen = vi.fn<() => void>();
    controller.reopenSession = reopen;
    controller.run("reopen_closed_session");
    expect(reopen).toHaveBeenCalledOnce();
  });

  it("refuses on a workspace of another machine, and says so", () => {
    const controller = new Controller();
    invoke.mockClear();
    controller.reopenClosed("w1", null);
    expect(invoke).not.toHaveBeenCalled();
    expect(controller.getState().notice).toMatch(/this computer/);
  });

  it("says when there is nothing to reopen", async () => {
    invoke.mockReset();
    answers([]);
    const controller = new Controller();
    (controller as unknown as { state: { snapshot: Snapshot } }).state.snapshot = snapshot([]);
    controller.reopenClosed("w1", ["/code/app"]);
    await settle();
    expect(resumed()).toEqual([]);
    expect(controller.getState().notice).toMatch(/No closed session/);
  });

  it("starts one tab for a session, however many clicks it gets, and forgets it after", async () => {
    invoke.mockReset();
    answers([]);
    const controller = new Controller();
    controller.resumeSession("w1", "a");
    controller.resumeSession("w1", "a");
    expect(resumed()).toEqual([{ workspaceId: "w1", session: "a" }]);
    expect(controller.getState().resuming.has("a")).toBe(true);
    await settle();
    expect(controller.getState().resuming.has("a")).toBe(false);
  });

  it("closes a view over the terminal, as the new tab comes to the front", () => {
    invoke.mockReset();
    answers([]);
    const controller = new Controller();
    const closeViews = vi.fn<() => void>();
    controller.closeViews = closeViews;
    controller.resumeSession("w1", "a");
    expect(closeViews).toHaveBeenCalledOnce();
  });

  it("shows a refused resume and lets it be tried again", async () => {
    invoke.mockReset();
    invoke.mockRejectedValue("that session is already running, in a tab or a terminal");
    const controller = new Controller();
    controller.resumeSession("w1", "a");
    await settle();
    expect(controller.getState().notice).toMatch(/already running/);
    expect(controller.getState().resuming.size).toBe(0);
  });
});

describe("day groups", () => {
  const noon = new Date(2026, 10, 18, 12).getTime(); // a Wednesday
  const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime() / 1000;

  it("go by the calendar, the week from Monday", () => {
    expect(dayOf(at(2026, 10, 18, 0), noon)).toBe("Today");
    expect(dayOf(at(2026, 10, 17, 23), noon)).toBe("Yesterday");
    expect(dayOf(at(2026, 10, 16), noon)).toBe("This week");
    expect(dayOf(at(2026, 10, 15), noon)).toBe("This month");
    expect(dayOf(at(2026, 9, 31), noon)).toBe("Older");
  });

  it("cut a newest-first list into runs", () => {
    const list = [session("a", { updated_at: at(2026, 10, 18) }), session("b", { updated_at: at(2026, 10, 18) }), session("c", { updated_at: at(2026, 9, 1) })];
    expect(byDay(list, noon).map((group) => [group.day, group.sessions.map((s) => s.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Older", ["c"]],
    ]);
  });
});

describe("outcomes on rows", () => {
  const outcome = (session: string, kind: string, over: Partial<Outcome> = {}) =>
    ({ id: `${session}-${kind}`, session, kind, resolved: null, superseded: false, stale: false, ...over }) as Outcome;

  it("take each session's newest", () => {
    const latest = latestOutcomes([outcome("a", "left"), outcome("a", "verified"), outcome("", "you")]);
    expect([...latest.keys()]).toEqual(["a"]);
    expect(latest.get("a")?.kind).toBe("left");
  });

  it("call open ones unfinished", () => {
    expect(outcomeBadge(outcome("a", "left"))).toEqual({ words: "Left for later", unfinished: true });
    expect(outcomeBadge(outcome("a", "you"))).toEqual({ words: "Waiting on you", unfinished: true });
    expect(outcomeBadge(outcome("a", "verified"))).toEqual({ words: "Done", unfinished: false });
    expect(outcomeBadge(outcome("a", "left", { resolved: { resolves: "x", how: "queued", at: "" } }))).toBeNull();
    expect(outcomeBadge(undefined)).toBeNull();
  });
});

describe("a session's workspace", () => {
  const places = [
    { workspaceId: "w1", label: "code", folders: ["/code"] },
    { workspaceId: "w2", label: "app", folders: ["/code/app", "/wt/app-x"] },
  ];
  it("is the one with the deepest folder holding it", () => {
    expect(placeOf(session("a", { folder: "/code/app/src" }), places)?.workspaceId).toBe("w2");
    expect(placeOf(session("a", { folder: "/wt/app-x" }), places)?.workspaceId).toBe("w2");
    expect(placeOf(session("a", { folder: "/code/other" }), places)?.workspaceId).toBe("w1");
    expect(placeOf(session("a", { folder: "/codex" }), places)).toBeNull();
  });
});
