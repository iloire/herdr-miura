import { describe, expect, it } from "vitest";
import { addItem, EMPTY_FILE, emptyQueue, type Queue, queueKey } from "../queue";
import type { Task } from "../todoist";
import {
  acceptedLabels,
  agentSuggestions,
  batchPrompt,
  isAgentTask,
  parseSuggestions,
  queuedTaskIds,
  type Suggestion,
  triagePrompt,
  triageRepos,
} from "../todoistTriage";

const task = (patch: Partial<Task> = {}): Task => ({
  id: "6gv",
  title: "Fix the filter",
  description: "It drops dots.",
  project: "Herdr",
  labels: ["agent"],
  priority: 1,
  due: null,
  due_words: null,
  url: "https://app.todoist.com/app/task/6gv",
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
      task({ id: "c", project: "Herdr", labels: ["agent", "repo:other"] }),
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
    const done: Queue = { ...emptyQueue("/x"), history: [{ ...queue.items[0], id: "q9", todoist: { id: "d", title: "D" } }] };
    expect([...queuedTaskIds([queue, done])].sort()).toEqual(["a", "b", "c", "d"]);
    // A batch keeps its first task where outcomes are written back from.
    expect(queue.items[1].todoist).toEqual({ id: "b", title: "B" });
    expect(queue.items[0].todoistBatch).toBeUndefined();
  });
});

describe("batchPrompt", () => {
  it("is the task alone for one, and one block each for several", () => {
    expect(batchPrompt([task()])).toMatch(/^Todoist task: Fix the filter/);
    const text = batchPrompt([task(), task({ id: "x", title: "Second", url: "https://app.todoist.com/app/task/x" })]);
    expect(text).toMatch(/^These 2 Todoist tasks are related/);
    expect(text).toContain("## 1. Fix the filter\n\nTodoist task: Fix the filter");
    expect(text).toContain("## 2. Second\n\nTodoist task: Second");
    expect(text).toContain("https://app.todoist.com/app/task/x");
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

describe("acceptedLabels", () => {
  const s = (patch: Partial<Suggestion>): Suggestion => ({ task: "6gv", repo: null, template: null, why: "", ...patch });
  const templates = ["plan", "fix", "agent"];

  it("adds a repo label, replacing another, unless the task goes there already", () => {
    expect(acceptedLabels(task({ labels: ["agent", "repo:old"] }), s({ repo: "dotfiles" }), templates, "old")).toEqual([
      "agent",
      "repo:dotfiles",
    ]);
    expect(acceptedLabels(task(), s({ repo: "herdr-miura" }), templates, "herdr-miura")).toBeNull();
  });

  it("adds the template as a label, replacing another template's but never @agent", () => {
    expect(acceptedLabels(task({ labels: ["agent", "fix", "home"] }), s({ template: "plan" }), templates, null)).toEqual([
      "agent",
      "home",
      "plan",
    ]);
    expect(acceptedLabels(task({ labels: ["agent", "plan"] }), s({ template: "Plan" }), templates, null)).toBeNull();
  });
});
