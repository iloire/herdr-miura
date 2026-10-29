import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Snapshot, Workspace } from "../../protocol";
import {
  addItem,
  EMPTY_FILE,
  emptyQueue,
  FINISH_DEBOUNCE_MS,
  itemOfTab,
  moveItem,
  promptText,
  type Queue,
  queueKey,
  recover,
  removeItem,
  restoreItem,
  step,
  title,
  type View,
  viewOf,
} from "../queue";

const FOLDER = "/code/app";

function agent(pane_id: string, agent_status: AgentStatus, over: Partial<Agent> = {}): Agent {
  return {
    pane_id,
    workspace_id: "w1",
    tab_id: "t",
    name: null,
    display_agent: null,
    agent: "claude",
    title: null,
    agent_status,
    tokens: [],
    focused: false,
    ...over,
  };
}

const workspace = { workspace_id: "w1", new_workspace_cwd: FOLDER } as Workspace;

function view(agents: Agent[], now: number, panes: string[] = agents.map((a) => a.pane_id)): View {
  return { now, workspaces: [workspace], agents, panes: new Set(panes) };
}

/// A queue with `prompts` waiting, in order.
function queued(...prompts: string[]): Queue {
  let file = EMPTY_FILE;
  for (const prompt of prompts) file = addItem(file, FOLDER, prompt, false, 0);
  return file.queues[queueKey(FOLDER)];
}

/// The first item started, opened in pane `p1` and prompted: running.
function running(queue: Queue): Queue {
  const started = step(queue, view([], 1000)).queue;
  const id = started.items[0].id;
  return {
    ...started,
    items: started.items.map((i) => (i.id === id ? { ...i, state: "running", paneId: "p1", tabId: "t1", opened: 1000 } : i)),
  };
}

describe("step", () => {
  it("starts the first waiting item when no agent is at work", () => {
    const { queue, effect } = step(queued("one", "two"), view([agent("x", "idle")], 1000));
    expect(effect).toMatchObject({ kind: "open", workspaceId: "w1", item: { n: 1, state: "starting" } });
    expect(queue.items.map((i) => i.state)).toEqual(["starting", "queued"]);
  });

  it("waits while any agent in the workspace works, waits on you, or loops", () => {
    for (const other of [
      agent("x", "working"),
      agent("x", "blocked"),
      agent("x", "done", { tokens: [["attn_loop", "↻ loop 14:32"]] }),
    ]) {
      const queue = queued("one");
      expect(step(queue, view([other], 1000))).toEqual({ queue, effect: null });
    }
  });

  it("never starts two items at once, even when asked twice in one tick", () => {
    const first = step(queued("one", "two"), view([], 1000));
    const second = step(first.queue, view([], 1000));
    expect(second.effect).toBeNull();
    expect(second.queue.items.filter((i) => i.state !== "queued")).toHaveLength(1);
  });

  it("finishes an item only after its agent stays quiet for the debounce", () => {
    let queue = running(queued("one", "two"));
    queue = step(queue, view([agent("p1", "done")], 2000)).queue;
    // A tool call in between resets the clock.
    queue = step(queue, view([agent("p1", "working")], 3000)).queue;
    queue = step(queue, view([agent("p1", "idle")], 4000)).queue;
    expect(step(queue, view([agent("p1", "idle")], 4000 + FINISH_DEBOUNCE_MS - 1)).effect).toBeNull();
    const { queue: ended, effect } = step(queue, view([agent("p1", "idle")], 4000 + FINISH_DEBOUNCE_MS));
    expect(effect).toMatchObject({ kind: "finished", item: { n: 1, state: "done" } });
    expect(ended.items.map((i) => i.n)).toEqual([2]);
    expect(ended.paused).toBeNull();
  });

  it("does not finish a session that /loop will run again", () => {
    let queue = running(queued("one"));
    const looping = agent("p1", "done", { tokens: [["$attn_loop", "↻ loop 14:32"]] });
    queue = step(queue, view([looping], 2000)).queue;
    expect(step(queue, view([looping], 2000 + FINISH_DEBOUNCE_MS * 3)).effect).toBeNull();
  });

  it("pauses when the item's tab is closed, after the grace for a new tab", () => {
    const queue = running(queued("one", "two"));
    expect(step(queue, view([], 2000, [])).effect).toBeNull();
    expect(step(queue, view([], 2000, [])).queue).toBe(queue);
    const { queue: stopped } = step(queue, view([], 60_000, []));
    expect(stopped.history[0]).toMatchObject({ state: "stopped", reason: "its tab was closed" });
    expect(stopped.paused?.reason).toBe("#1 its tab was closed.");
    expect(step(stopped, view([], 61_000)).effect).toBeNull();
  });

  it("stops an item whose agent exited, once that has lasted the debounce", () => {
    let queue = running(queued("one"));
    queue = step(queue, view([], 2000, ["p1"])).queue;
    const { queue: stopped } = step(queue, view([], 2000 + FINISH_DEBOUNCE_MS, ["p1"]));
    expect(stopped.history[0]).toMatchObject({ state: "stopped", reason: "its agent exited" });
  });

  it("prompts an agent that was not ready once it is idle", () => {
    const queue = running(queued("one"));
    const waiting = { ...queue, items: queue.items.map((i) => ({ ...i, state: "waiting" as const })) };
    expect(step(waiting, view([agent("p1", "blocked")], 2000)).effect).toBeNull();
    const { queue: prompting, effect } = step(waiting, view([agent("p1", "idle")], 3000));
    expect(effect).toMatchObject({ kind: "prompt", item: { n: 1 } });
    expect(prompting.items[0].state).toBe("prompting");
    expect(step(prompting, view([agent("p1", "idle")], 4000)).effect).toBeNull();
  });

  it("pauses after the running item when asked to stop after it", () => {
    let queue = { ...running(queued("one", "two")), stopAfter: true };
    queue = step(queue, view([agent("p1", "done")], 2000)).queue;
    const { queue: ended } = step(queue, view([agent("p1", "done")], 2000 + FINISH_DEBOUNCE_MS));
    expect(ended.paused?.reason).toMatch(/Stopped after #1/);
    expect(ended.stopAfter).toBe(false);
    expect(step(ended, view([], 99_000)).effect).toBeNull();
  });

  it("does nothing without a workspace on the folder", () => {
    const queue = queued("one");
    expect(step(queue, { ...view([], 1000), workspaces: [] }).effect).toBeNull();
  });
});

describe("viewOf", () => {
  it("covers every workspace opened on the queue's folder", () => {
    const snapshot = {
      workspaces: [
        { workspace_id: "w1", new_workspace_cwd: FOLDER, active_tab_id: "" },
        { workspace_id: "w2", new_workspace_cwd: FOLDER, active_tab_id: "" },
        { workspace_id: "w3", new_workspace_cwd: "/elsewhere", active_tab_id: "" },
      ],
      agents: [agent("a", "idle", { workspace_id: "w2" }), agent("b", "working", { workspace_id: "w3" })],
      panes: [{ pane_id: "a" }],
    } as unknown as Snapshot;
    const seen = viewOf(emptyQueue(FOLDER), snapshot, 5);
    expect(seen.workspaces.map((w) => w.workspace_id)).toEqual(["w1", "w2"]);
    expect(seen.agents.map((a) => a.pane_id)).toEqual(["a"]);
  });
});

describe("editing a queue", () => {
  it("numbers items per queue and ids them across queues", () => {
    let file = addItem(EMPTY_FILE, FOLDER, "  one  ", false, 0);
    file = addItem(file, "/other", "x", false, 0);
    file = addItem(file, FOLDER, "two", true, 0);
    const queue = file.queues[queueKey(FOLDER)];
    expect(queue.items.map((i) => [i.id, i.n, i.prompt])).toEqual([
      ["q3", 2, "two"],
      ["q1", 1, "one"],
    ]);
  });

  it("puts a prompt added to the front after the item in progress", () => {
    const started = step(queued("one", "two"), view([], 1000)).queue;
    const file = addItem({ version: 1, seq: 2, queues: { [queueKey(FOLDER)]: started } }, FOLDER, "urgent", true, 0);
    expect(file.queues[queueKey(FOLDER)].items.map((i) => i.prompt)).toEqual(["one", "urgent", "two"]);
  });

  it("reorders only what is waiting, and undoes a removal", () => {
    const started = step(queued("a", "b", "c"), view([], 1000)).queue;
    expect(moveItem(started, started.items[2].id, -1).items.map((i) => i.prompt)).toEqual(["a", "c", "b"]);
    expect(moveItem(started, started.items[1].id, -1)).toBe(started);
    expect(removeItem(started, started.items[0].id).index).toBe(-1);
    const { queue, index } = removeItem(started, started.items[1].id);
    expect(queue.items.map((i) => i.prompt)).toEqual(["a", "c"]);
    expect(restoreItem(queue, started.items[1], index).items.map((i) => i.prompt)).toEqual(["a", "b", "c"]);
  });

  it("fails an item caught starting when the app closed, and runs one caught prompting", () => {
    const queue = step(queued("a", "b"), view([], 1000)).queue;
    const file = recover({ version: 1, seq: 2, queues: { k: queue } }, 9000).queues.k;
    expect(file.history[0]).toMatchObject({ state: "failed", n: 1 });
    expect(file.paused).not.toBeNull();
    const prompting = { ...queue, items: queue.items.map((i, n) => (n === 0 ? { ...i, state: "prompting" as const } : i)) };
    expect(recover({ version: 1, seq: 2, queues: { k: prompting } }, 9000).queues.k.items[0].state).toBe("running");
  });
});

describe("text", () => {
  it("titles a prompt by its first line with text", () => {
    expect(title("\n  Fix the tab bar\nthen more")).toBe("Fix the tab bar");
    expect(title("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("asks for a commit only while that is ticked", () => {
    const queue = queued("Do it.");
    expect(promptText(queue.items[0], queue)).toMatch(/^Do it\.\n\nWhen you are done, commit/);
    expect(promptText(queue.items[0], { ...queue, commitSuffix: false })).toBe("Do it.");
  });

  it("finds the item a tab runs and where it stands", () => {
    const queue = running(queued("a", "b"));
    const found = itemOfTab({ version: 1, seq: 2, queues: { k: queue } }, "t1");
    expect(found).toMatchObject({ item: { n: 1 }, position: 1, total: 2, next: { n: 2 } });
    expect(itemOfTab({ version: 1, seq: 2, queues: { k: queue } }, "t9")).toBeNull();
  });
});
