import { describe, expect, it } from "vitest";
import { addItem, EMPTY_FILE, emptyQueue, type Queue, queueKey } from "../queue";
import type { Task } from "../doable";
import {
  accepted,
  agentSuggestions,
  handedOver,
  isAgentTask,
  parseSuggestions,
  queuedTaskIds,
  type Suggestion,
  triagePrompt,
  triageRepos,
} from "../doableTriage";

const task = (patch: Partial<Task> = {}): Task => ({
  id: "6gv",
  title: "Fix the filter",
  description: "It drops dots.",
  project: "Herdr",
  labels: ["agent"],
  priority: 1,
  due: null,
  due_words: null,
  repo: null,
  url: "https://doable-chi.vercel.app/",
  ...patch,
});

const projects = { Herdr: "~/code/herdr-miura" };
const HOME = "/Users/me";
const REPO = "/Users/me/code/herdr-miura";

describe("@agent tasks", () => {
  it("are told by their label, any case", () => {
    expect(isAgentTask(task())).toBe(true);
    expect(isAgentTask(task({ labels: ["Agent"] }))).toBe(true);
    expect(isAgentTask(task({ labels: ["agents", "plan"] }))).toBe(false);
  });

  it("are suggested in their repo's queue, or any when unrouted, and not once queued", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", project: "Elsewhere" }),
      task({ id: "c", project: "Herdr", repo: "iloire/other" }),
      task({ id: "d", labels: ["plan"] }),
      task({ id: "e" }),
    ];
    const shown = agentSuggestions(tasks, new Set(["e"]), REPO, projects, HOME, ["/Users/me/code/other"]);
    expect(shown.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("queuedTaskIds", () => {
  it("reads single and batch tasks from waiting and finished items", () => {
    let file = addItem(EMPTY_FILE, REPO, "one", false, 1, undefined, { id: "a", title: "A" });
    file = addItem(file, REPO, "two", false, 2, undefined, [
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ]);
    const queue = file.queues[queueKey(REPO)];
    const done: Queue = { ...emptyQueue("/x"), history: [{ ...queue.items[0], id: "q9", doable: { id: "d", title: "D" } }] };
    expect([...queuedTaskIds([queue, done])].sort()).toEqual(["a", "b", "c", "d"]);
    // A batch keeps its first task where outcomes are written back from.
    expect(queue.items[1].doable).toEqual({ id: "b", title: "B" });
    expect(queue.items[0].doableBatch).toBeUndefined();
  });
});

describe("triage", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", title: "Plan the move" })];
  const repos = ["herdr-miura", "dotfiles"];
  const templates = ["plan", "fix"];

  it("asks with the tasks, repos and templates on offer", () => {
    const text = triagePrompt(tasks, repos, [{ name: "plan", description: "Write a plan" }, { name: "fix", description: null }]);
    expect(text).toContain('Repos: ["herdr-miura","dotfiles"]');
    expect(text).toContain('Templates: ["plan: Write a plan","fix"]');
    expect(text).toContain('"id": "b"');
    expect(text).toContain('"title": "Plan the move"');
  });

  it("keeps only known tasks, repos and templates, as offered", () => {
    const answer = `Sure:\n[{"id":"a","repo":"HERDR-MIURA","template":"nope","why":"app code"},
      {"id":"b","repo":null,"template":"Plan","why":"a plan"},
      {"id":"zz","repo":"dotfiles","template":"fix"},
      {"id":"a","repo":"dotfiles"},
      {"id":"b2","repo":"elsewhere","template":null}]`;
    expect(parseSuggestions(answer, [...tasks, task({ id: "b2" })], repos, templates)).toEqual([
      { task: "a", repo: "herdr-miura", template: null, why: "app code" },
      { task: "b", repo: null, template: "plan", why: "a plan" },
    ]);
  });

  it("offers mapped and open repos by name, once each", () => {
    expect(triageRepos(projects, HOME, [REPO, "/Users/me/dotfiles/"])).toEqual(["dotfiles", "herdr-miura"]);
  });

  it("gives nothing for an answer that is not a list", () => {
    expect(parseSuggestions("I could not decide.", tasks, repos, templates)).toEqual([]);
    expect(parseSuggestions("[not json]", tasks, repos, templates)).toEqual([]);
  });
});

describe("accepted", () => {
  const s = (patch: Partial<Suggestion>): Suggestion => ({ task: "6gv", repo: null, template: null, why: "", ...patch });
  const templates = ["plan", "fix", "agent"];

  it("sets the repo link unless the task goes there already", () => {
    expect(accepted(task(), s({ repo: "dotfiles" }), templates, "old")).toEqual({ labels: ["agent"], repo: "dotfiles" });
    expect(accepted(task(), s({ repo: "herdr-miura" }), templates, "herdr-miura")).toBeNull();
  });

  it("adds the template as a label, replacing another template's but never @agent", () => {
    expect(accepted(task({ labels: ["agent", "fix", "home"] }), s({ template: "plan" }), templates, null)).toEqual({
      labels: ["agent", "home", "plan"],
      repo: null,
    });
    expect(accepted(task({ labels: ["agent", "plan"] }), s({ template: "Plan" }), templates, null)).toBeNull();
  });
});

describe("tasks handed to Claude on the Mac", () => {
  const targets = [{ folder: REPO, queueFolder: REPO, label: "herdr-miura" }];

  it("start in their repo's workspace by themselves, once, and only when queued on the Mac", () => {
    const tasks = [
      task({ id: "mac", agent: "queued" }),
      task({ id: "phone" }),
      task({ id: "running", agent: "running" }),
      task({ id: "in-queue", agent: "queued" }),
      task({ id: "added-before", agent: "queued" }),
      task({ id: "nowhere", agent: "queued", project: "Elsewhere" }),
    ];
    const picked = handedOver(tasks, new Set(["in-queue"]), new Set(["added-before"]), targets, projects, HOME);
    expect(picked.map(({ task: t, target }) => [t.id, target.queueFolder])).toEqual([["mac", REPO]]);
  });

  it("go to the Doable tasks workspace when no repo claims them", () => {
    const notes = { folder: "/Users/me/notes", queueFolder: "/Users/me/notes#split-w9", label: "doable tasks " };
    const tasks = [task({ id: "mac", agent: "queued" }), task({ id: "errand", agent: "queued", project: "Home" })];
    const picked = handedOver(tasks, new Set(), new Set(), [...targets, notes], projects, HOME);
    expect(picked.map(({ task: t, target }) => [t.id, target.label])).toEqual([
      ["mac", "herdr-miura"],
      ["errand", "doable tasks "],
    ]);
  });
});
