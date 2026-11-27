import { describe, expect, it } from "vitest";
import type { Prompt } from "../promptLibrary";
import {
  dueBy,
  dueLabel,
  expandFolder,
  fillTemplate,
  isMapped,
  matchingTasks,
  noToken,
  parkedTask,
  queuedTask,
  overdue,
  projectFor,
  sendTarget,
  sortTasks,
  type Target,
  type Task,
  taskBlock,
  taskRepo,
  tasksFor,
  taskUrl,
  templateFor,
  loadView,
  localDue,
  projectView,
  saveView,
  viewedProject,
} from "../doable";

describe("views", () => {
  it("names a project, and knows which project a view lists", () => {
    expect(projectView("Work & Home")).toBe("project:Work & Home");
    expect(viewedProject(projectView("Work & Home"), ["Inbox", "Work & Home"])).toBe("Work & Home");
    expect(viewedProject("today", ["Inbox"])).toBeNull();
    expect(viewedProject(null, ["Inbox"])).toBeNull();
  });

  it("keeps the picked view, and none when storage fails", () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    };
    saveView("project:Inbox", storage);
    expect(loadView(storage)).toBe("project:Inbox");
    saveView(null, storage);
    expect(loadView(storage)).toBeNull();
    expect(loadView({ getItem: () => { throw new Error("blocked"); } })).toBeNull();
  });
});

const task = (patch: Partial<Task> = {}): Task => ({
  id: "6F96-B42D",
  title: "Fix the filter",
  description: "It drops dots.",
  project: "Herdr",
  labels: ["bug"],
  priority: 1,
  due: "2026-11-13",
  due_words: "friday",
  repo: null,
  url: "https://doable-chi.vercel.app/",
  ...patch,
});

const prompt = (name: string, patch: Partial<Prompt> = {}): Prompt => ({
  key: `global:${name}.md`,
  name,
  scope: "global",
  path: `${name}.md`,
  dir: "/x",
  group: null,
  description: null,
  argumentHint: null,
  run: null,
  body: "Do it.",
  raw: "Do it.",
  broken: null,
  overrides: false,
  ...patch,
});

describe("taskBlock", () => {
  it("holds the title, facts, description and id", () => {
    expect(taskBlock(task({ repo: "iloire/herdr-miura" }))).toBe(
      "Doable task: Fix the filter\nProject: Herdr · Labels: @bug · Due: friday · Repo: iloire/herdr-miura\n\nIt drops dots.\n\nDoable id: 6F96-B42D",
    );
  });

  it("leaves out what the task does not have", () => {
    expect(taskBlock(task({ project: null, labels: [], due: null, due_words: null, description: " " }))).toBe(
      "Doable task: Fix the filter\n\nDoable id: 6F96-B42D",
    );
  });
});

describe("fillTemplate", () => {
  it("is the task alone without a template", () => {
    expect(fillTemplate(null, task())).toBe(taskBlock(task()));
  });

  it("fills named fields and the whole block", () => {
    expect(fillTemplate("Plan {{task.title}} ({{ task.labels }}) {{task.nope}}\n{{task}}", task())).toBe(
      `Plan Fix the filter (bug) {{task.nope}}\n${taskBlock(task())}`,
    );
  });

  it("puts the block for $ARGUMENTS", () => {
    expect(fillTemplate("Investigate: $ARGUMENTS", task())).toBe(`Investigate: ${taskBlock(task())}`);
  });

  it("appends the block to a plain prompt", () => {
    expect(fillTemplate("Write the plan.\n", task())).toBe(`Write the plan.\n\n${taskBlock(task())}`);
  });
});

describe("templateFor", () => {
  it("prefers a prompt named as a label, then doable", () => {
    const prompts = [prompt("doable"), prompt("Bug")];
    expect(templateFor(task(), prompts)?.name).toBe("Bug");
    expect(templateFor(task({ labels: [] }), prompts)?.name).toBe("doable");
    expect(templateFor(task({ labels: [] }), [prompt("plan")])).toBeNull();
  });

  it("skips a broken prompt", () => {
    expect(templateFor(task(), [prompt("bug", { broken: "no text" })])).toBeNull();
  });
});

describe("sortTasks", () => {
  it("puts dated first, earliest first, then urgent first", () => {
    const tasks = [
      task({ id: "none", due: null }),
      task({ id: "late", due: "2026-11-14" }),
      task({ id: "low", due: "2026-11-13", priority: 1 }),
      task({ id: "high", due: "2026-11-13", priority: 4 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["high", "low", "late", "none"]);
  });
});

describe("overdue and matchingTasks", () => {
  it("compares the day only", () => {
    expect(overdue(task({ due: "2026-11-12T09:00:00" }), "2026-11-13")).toBe(true);
    expect(overdue(task({ due: "2026-11-13T23:00:00" }), "2026-11-13")).toBe(false);
    expect(overdue(task({ due: null }), "2026-11-13")).toBe(false);
  });

  it("finds every word across fields", () => {
    expect(matchingTasks([task()], "herdr dots")).toHaveLength(1);
    expect(matchingTasks([task()], "herdr nope")).toHaveLength(0);
  });
});

describe("repo routing", () => {
  const home = "/Users/me";
  const projects = { Herdr: "~/code/herdr-miura/", Life: "/Users/me/notes" };

  it("expands ~ and drops a trailing slash", () => {
    expect(expandFolder("~/code/app/", home)).toBe("/Users/me/code/app");
    expect(expandFolder("~", "/Users/me/")).toBe("/Users/me");
    expect(expandFolder("~/code", null)).toBe("~/code");
    expect(expandFolder("/", home)).toBe("/");
    expect(expandFolder("~other/x", home)).toBe("~other/x");
  });

  it("routes a task by its project, any case", () => {
    expect(taskRepo(task(), projects, home)).toBe("/Users/me/code/herdr-miura");
    expect(taskRepo(task({ project: "life" }), projects, home)).toBe("/Users/me/notes");
    expect(taskRepo(task({ project: "Work" }), projects, home)).toBeNull();
    expect(taskRepo(task({ project: null }), projects, home)).toBeNull();
  });

  it("lets a repo link override the project", () => {
    expect(taskRepo(task({ repo: "Life" }), projects, home)).toBe("/Users/me/notes");
    expect(taskRepo(task({ repo: "iloire/notes" }), projects, home)).toBe("/Users/me/notes");
    expect(taskRepo(task({ project: null, repo: "iloire/wind-hunter" }), projects, home, ["/Users/me/code/wind-hunter"])).toBe(
      "/Users/me/code/wind-hunter",
    );
  });

  it("leaves a task unrouted when its repo link names nothing known", () => {
    expect(taskRepo(task({ repo: "nope" }), projects, home, ["/Users/me/code/app"])).toBeNull();
  });

  it("knows a mapped folder, however it is written", () => {
    expect(isMapped("/Users/me/code/herdr-miura", projects, home)).toBe(true);
    expect(isMapped("/Users/me/code/herdr-miura/", projects, home)).toBe(true);
    expect(isMapped("/Users/me/code/app", projects, home)).toBe(false);
    expect(isMapped(null, projects, home)).toBe(false);
  });

  it("keeps the tasks for one repo", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", project: "Life" }), task({ id: "c", repo: "herdr" }), task({ id: "d", project: "Herdr", repo: "life" })];
    expect(tasksFor(tasks, "/Users/me/code/herdr-miura", projects, home).map((t) => t.id)).toEqual(["a", "c"]);
    expect(tasksFor(tasks, "/Users/me/notes", projects, home).map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("offers the open workspace on another repo, its main queue first", () => {
    const split: Target = { workspaceId: "w2", label: "notes split", folder: "/Users/me/notes", queueFolder: "/Users/me/notes#split-w2" };
    const main: Target = { workspaceId: "w3", label: "notes", folder: "/Users/me/notes", queueFolder: "/Users/me/notes" };
    expect(sendTarget("/Users/me/notes", "/Users/me/code/herdr-miura", [split, main])).toBe(main);
    expect(sendTarget("/Users/me/notes", "/Users/me/code/herdr-miura", [split])).toBe(split);
    expect(sendTarget("/Users/me/notes", "/Users/me/notes", [main])).toBeNull();
    expect(sendTarget(null, "/Users/me/notes", [main])).toBeNull();
    expect(sendTarget("/Users/me/code/app", null, [main])).toBeNull();
  });
});

describe("due dates", () => {
  it("reads Doable's instant in local time", () => {
    const local = new Date(2026, 10, 13, 0, 0);
    expect(localDue(local.toISOString(), false)).toBe("2026-11-13");
    expect(localDue(new Date(2026, 10, 13, 9, 5).toISOString(), true)).toBe("2026-11-13T09:05");
    expect(localDue(null, false)).toBeNull();
    expect(localDue("nonsense", false)).toBeNull();
  });

  it("names the day from today, not from the words typed", () => {
    const today = "2026-11-13";
    expect(dueLabel(task({ due: "2026-11-13", due_words: "tomorrow" }), today)).toBe("Today");
    expect(dueLabel(task({ due: "2026-11-14T09:30" }), today)).toBe("Tomorrow 09:30");
    expect(dueLabel(task({ due: "2026-11-16" }), today)).toBe("Monday");
    expect(dueLabel(task({ due: "2026-11-11" }), today)).toBe("11 Nov");
    expect(dueLabel(task({ due: "2027-01-04", due_words: "every monday" }), today)).toBe("4 Jan 2027 · every monday");
    expect(dueLabel(task({ due: null }), today)).toBe("");
  });
});

describe("the status bar count and quick add", () => {
  it("counts the tasks due today or before", () => {
    const tasks = [task({ due: "2026-11-12" }), task({ due: "2026-11-13T09:00:00" }), task({ due: "2026-11-14" }), task({ due: null })];
    expect(dueBy(tasks, "2026-11-13")).toBe(2);
    expect(dueBy([], "2026-11-13")).toBe(0);
  });

  it("knows a missing token from a broken one", () => {
    expect(noToken("no Doable token: add it to the keychain")).toBe(true);
    expect(noToken("Doable refused the token (HTTP 401)")).toBe(false);
  });

  it("adds to the project mapped to the workspace's folder, else none", () => {
    const projects = { Herdr: "~/code/herdr-miura/", Notes: "/Users/me/notes" };
    expect(projectFor("/Users/me/code/herdr-miura", projects, "/Users/me")).toBe("Herdr");
    expect(projectFor("/Users/me/notes/", projects, "/Users/me")).toBe("Notes");
    expect(projectFor("/Users/me/code/other", projects, "/Users/me")).toBeNull();
    expect(projectFor(null, projects, "/Users/me")).toBeNull();
  });

  it("links a task as doable.rs does", () => {
    expect(taskUrl("6F96-B42D")).toBe(task().url);
  });

  it("sends a parked note with its repo and branch", () => {
    const outcome = {
      id: "1-2", at: "2026-11-12T10:00:00Z", kind: "left", note: "Test it on GTK\nthe tray too", cwd: "", home: "/Users/me/code/herdr-miura",
      branch: "fix-x", head: "", session: "", workspace: "", pane: "", time: 0, resolved: null, superseded: false, stale: false,
    };
    expect(parkedTask(outcome, "/Users/me")).toEqual({
      title: "Test it on GTK",
      description: "the tray too\n\nLeft for later by an agent in Herdr Miura, 2026-11-12T10:00:00Z.\nRepo: `~/code/herdr-miura`\nBranch: `fix-x`",
    });
    expect(parkedTask({ ...outcome, note: "", home: "", branch: "" }, null)).toEqual({
      title: "Left for later by an agent",
      description: "Left for later by an agent in Herdr Miura, 2026-11-12T10:00:00Z.",
    });
  });

  it("keeps a queued prompt whole in a dated task", () => {
    expect(queuedTask("\nFix the login\n\nWhy: flaky\n", "/Users/me/code/app", " tomorrow 9am ", "/Users/me")).toEqual({
      title: "Fix the login",
      description: "A prompt from Herdr Miura's queue for `~/code/app`, to queue again when it is due.\n\nFix the login\n\nWhy: flaky",
      due: "tomorrow 9am",
    });
  });
});
