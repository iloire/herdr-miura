import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentStatus, Pane, Snapshot } from "../../protocol";
import { agentRefusal, canLand, LandStore, landing, type LandOutcome } from "../land";
import type { Worktree } from "../worktrees";

const invoke = vi.hoisted(() => vi.fn());
const channels = vi.hoisted(() => [] as { onmessage: (step: string) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: (step: string) => void = () => {};
    constructor() {
      channels.push(this);
    }
  },
}));

const worktree = (over: Partial<Worktree> = {}): Worktree => ({
  path: "/r/.claude/worktrees/x",
  branch: "feat/x",
  subject: "the work",
  time: 1,
  base: "origin/main",
  unmerged: 3,
  changed: 0,
  repo: "/r",
  main: "main",
  ahead: 3,
  ...over,
});

const agent = (agent_status: AgentStatus, tokens: [string, string][] = []): Agent => ({
  pane_id: "p1",
  workspace_id: "w1",
  tab_id: "t1",
  name: null,
  display_agent: "Claude",
  agent: "claude",
  title: null,
  terminal_title_stripped: null,
  agent_status,
  state_change_seq: 1,
  tokens,
  focused: false,
});

const pane = (over: Partial<Pane> = {}): Pane => ({
  pane_id: "p1",
  workspace_id: "w1",
  tab_id: "t1",
  label: null,
  cwd: "/somewhere/else",
  foreground_cwd: null,
  focused: false,
  right_click_passthrough: false,
  ...over,
});

const snapshot = (agents: Agent[], panes: Pane[]): Snapshot =>
  ({ agents, panes, tabs: [], workspaces: [] }) as unknown as Snapshot;

const PLAN = { branch: "feat/x", head: "abcdef0123456789", main: "main", commits: 3, check: "npm run check" };
const READY = { kind: "ready", ...PLAN };
const LANDED: LandOutcome = { kind: "landed", main: "main", commits: 3 };
const STOPPED: LandOutcome = { kind: "failed", step: "rebase", message: "conflict", left: "as it was", details: "" };
const TARGET = { worktree: worktree().path, branch: "feat/x", head: PLAN.head, check: PLAN.check };

/// Answers each command with its entry; a function runs first, as the backend would.
function answer(answers: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string) => {
    const reply = answers[command];
    return typeof reply === "function" ? reply() : reply;
  });
}

const commands = () => invoke.mock.calls.map(([command]) => command);

describe("canLand", () => {
  it("offers a branch with commits main lacks", () => {
    expect(canLand(worktree())).toBe(true);
  });

  it("goes by local main, not the remote's count", () => {
    expect(canLand(worktree({ unmerged: 3, ahead: 0 }))).toBe(false);
    expect(canLand(worktree({ unmerged: 0, ahead: 1 }))).toBe(true);
  });

  it("does not offer a merged branch, an unknown count or a detached HEAD", () => {
    expect(canLand(worktree({ ahead: null }))).toBe(false);
    expect(canLand(worktree({ branch: null }))).toBe(false);
  });
});

describe("agentRefusal", () => {
  const inTree = pane({ cwd: "/r/.claude/worktrees/x/src" });

  it("refuses an agent working or blocked in the worktree", () => {
    expect(agentRefusal(worktree().path, snapshot([agent("working")], [inTree]))).toBe(
      "Claude is working in this worktree.",
    );
    expect(agentRefusal(worktree().path, snapshot([agent("blocked")], [inTree]))).not.toBeNull();
  });

  it("refuses a session that /loop will run again, though idle now", () => {
    const looping = agent("idle", [["attn_loop", "↻ loop 14:32"]]);
    expect(agentRefusal(worktree().path, snapshot([looping], [inTree]))).not.toBeNull();
  });

  it("sees an agent by the folder of its foreground process too", () => {
    const moved = pane({ cwd: "/r", foreground_cwd: worktree().path });
    expect(agentRefusal(worktree().path, snapshot([agent("working")], [moved]))).not.toBeNull();
  });

  it("lets a finished or idle agent be", () => {
    expect(agentRefusal(worktree().path, snapshot([agent("idle")], [inTree]))).toBeNull();
    expect(agentRefusal(worktree().path, snapshot([agent("done")], [inTree]))).toBeNull();
  });

  it("ignores agents elsewhere, a sibling with the same prefix included", () => {
    expect(agentRefusal(worktree().path, snapshot([agent("working")], [pane()]))).toBeNull();
    const sibling = pane({ cwd: `${worktree().path}-two` });
    expect(agentRefusal(worktree().path, snapshot([agent("working")], [sibling]))).toBeNull();
  });

  it("refuses when it cannot see the agents at all", () => {
    expect(agentRefusal(worktree().path, null)).not.toBeNull();
  });
});

describe("LandStore", () => {
  const free = () => null;
  let store: LandStore;
  let settled: ReturnType<typeof vi.fn>;
  const land = () => store.getState().get("/r");

  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
    settled = vi.fn();
    store = new LandStore(settled as () => void);
  });

  it("asks before anything runs", async () => {
    answer({ land_plan: READY });
    await store.ask("w1", worktree(), free);
    expect(land()?.phase).toBe("asking");
    expect(commands()).toEqual(["land_plan"]);
  });

  it("runs the check, then the rest, with what was confirmed", async () => {
    answer({ land_plan: READY, land_check: { kind: "passed" }, land_finish: LANDED });
    await store.ask("w1", worktree(), free);
    await store.confirm("/r");
    expect(commands()).toEqual(["land_plan", "land_check", "land_finish"]);
    expect(invoke.mock.calls[1]?.[1]).toEqual({ target: TARGET });
    expect(land()).toMatchObject({ phase: "ended", branch: "feat/x", outcome: LANDED, card: "w1" });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("cancelling runs nothing and leaves nothing", async () => {
    answer({ land_plan: READY });
    await store.ask("w1", worktree(), free);
    store.cancel("/r");
    await store.confirm("/r");
    expect(land()).toBeUndefined();
    expect(commands()).toEqual(["land_plan"]);
  });

  it("refuses a working agent without asking the backend", async () => {
    await store.ask("w1", worktree(), () => "Claude is working in this worktree.");
    expect(invoke).not.toHaveBeenCalled();
    expect(land()).toMatchObject({
      phase: "ended",
      outcome: { step: "start", message: "Claude is working in this worktree.", left: "Nothing changed." },
    });
  });

  it("refuses an agent that started while the dialog was open", async () => {
    answer({ land_plan: READY });
    let refusal: string | null = null;
    await store.ask("w1", worktree(), () => refusal);
    refusal = "Claude is working in this worktree.";
    await store.confirm("/r");
    expect(commands()).toEqual(["land_plan"]);
    expect(land()).toMatchObject({ outcome: { step: "start" } });
  });

  it("stops after the check when an agent started during it", async () => {
    let refusal: string | null = null;
    answer({
      land_plan: READY,
      land_check: () => {
        refusal = "Claude is working in this worktree.";
        return { kind: "passed" };
      },
    });
    await store.ask("w1", worktree(), () => refusal);
    await store.confirm("/r");
    expect(commands()).toEqual(["land_plan", "land_check"]);
    expect(land()).toMatchObject({ outcome: { step: "check", left: "feat/x is as it was, at abcdef0. main did not move." } });
  });

  it("leaves the backend's refusal on the card", async () => {
    answer({ land_plan: { kind: "refused", message: "The worktree has 2 uncommitted files." } });
    await store.ask("w1", worktree(), free);
    expect(land()).toMatchObject({ phase: "ended", outcome: { message: "The worktree has 2 uncommitted files." } });
  });

  it("does not go on after a failing check", async () => {
    const failing: LandOutcome = { ...STOPPED, step: "check" };
    answer({ land_plan: READY, land_check: failing });
    await store.ask("w1", worktree(), free);
    await store.confirm("/r");
    expect(commands()).not.toContain("land_finish");
    expect(land()).toMatchObject({ phase: "ended", outcome: failing });
  });

  it("keeps a failure's step and what it left", async () => {
    answer({ land_plan: READY, land_check: { kind: "passed" }, land_finish: STOPPED });
    await store.ask("w1", worktree(), free);
    await store.confirm("/r");
    expect(land()).toMatchObject({ phase: "ended", outcome: STOPPED });
  });

  it("shows each step, and a late one cannot reopen a finished land", async () => {
    let seen: unknown;
    answer({
      land_plan: READY,
      land_check: { kind: "passed" },
      land_finish: () => {
        channels[0]?.onmessage("rebase");
        seen = land();
        return LANDED;
      },
    });
    await store.ask("w1", worktree(), free);
    const running = store.confirm("/r");
    expect(land()).toMatchObject({ phase: "running", step: "check" });
    await running;
    expect(seen).toMatchObject({ phase: "running", step: "rebase" });
    channels[0]?.onmessage("confirm");
    expect(land()?.phase).toBe("ended");
  });

  it("starts one land per repo, and any number across repos", async () => {
    answer({ land_plan: READY });
    await store.ask("w1", worktree(), free);
    expect(landing(land())).toBe(true);
    await store.ask("w1", worktree({ path: "/r/other" }), free);
    expect(commands()).toEqual(["land_plan"]);
    await store.ask("w2", worktree({ repo: "/s", path: "/s/x" }), free);
    expect(commands()).toEqual(["land_plan", "land_plan"]);
  });

  it("allows another land once one has ended, and a dismissal clears it", async () => {
    await store.ask("w1", worktree(), () => "no");
    expect(landing(land())).toBe(false);
    store.dismiss("/r");
    expect(land()).toBeUndefined();
  });

  it("a double click on Land runs it once", async () => {
    answer({ land_plan: READY, land_check: { kind: "passed" }, land_finish: LANDED });
    await store.ask("w1", worktree(), free);
    await Promise.all([store.confirm("/r"), store.confirm("/r")]);
    expect(commands()).toEqual(["land_plan", "land_check", "land_finish"]);
  });

  it("cancel cannot drop a land that is running", async () => {
    let during: string | undefined;
    answer({
      land_plan: READY,
      land_check: () => {
        store.cancel("/r");
        during = land()?.phase;
        return { kind: "passed" };
      },
      land_finish: LANDED,
    });
    await store.ask("w1", worktree(), free);
    await store.confirm("/r");
    expect(during).toBe("running");
  });

  it("does not dismiss a land under way", async () => {
    answer({ land_plan: READY });
    await store.ask("w1", worktree(), free);
    store.dismiss("/r");
    expect(land()?.phase).toBe("asking");
  });

  it("says it lost track when a command itself fails", async () => {
    answer({
      land_plan: READY,
      land_check: () => {
        throw new Error("worker gone");
      },
    });
    await store.ask("w1", worktree(), free);
    await store.confirm("/r");
    expect(land()).toMatchObject({ phase: "ended", outcome: { kind: "failed" } });
    expect(settled).toHaveBeenCalledOnce();
  });
});
