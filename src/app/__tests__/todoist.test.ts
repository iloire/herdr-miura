import { describe, expect, it } from "vitest";
import type { Prompt } from "../promptLibrary";
import {
  commentsBlock,
  dueBy,
  expandFolder,
  fillTemplate,
  isMapped,
  matchingTasks,
  noToken,
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
} from "../todoist";

const task = (patch: Partial<Task> = {}): Task => ({
  id: "6gv",
  title: "Fix the filter",
  description: "It drops dots.",
  project: "Herdr",
  labels: ["bug"],
  priority: 1,
  due: "2026-11-13",
  due_words: "13 Nov",
  url: "https://app.todoist.com/app/task/6gv",
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
  it("holds the title, facts, description and link", () => {
    expect(taskBlock(task())).toBe(
      "Todoist task: Fix the filter\nProject: Herdr · Labels: @bug · Due: 13 Nov\n\nIt drops dots.\n\nhttps://app.todoist.com/app/task/6gv",
    );
  });

  it("leaves out what the task does not have", () => {
    expect(taskBlock(task({ project: null, labels: [], due_words: null, description: " " }))).toBe(
      "Todoist task: Fix the filter\n\nhttps://app.todoist.com/app/task/6gv",
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
  it("prefers a prompt named as a label, then todoist", () => {
    const prompts = [prompt("todoist"), prompt("Bug")];
    expect(templateFor(task(), prompts)?.name).toBe("Bug");
    expect(templateFor(task({ labels: [] }), prompts)?.name).toBe("todoist");
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

  it("lets a @repo: label override the project", () => {
    expect(taskRepo(task({ labels: ["repo:Life"] }), projects, home)).toBe("/Users/me/notes");
    expect(taskRepo(task({ labels: ["bug", "Repo:notes"] }), projects, home)).toBe("/Users/me/notes");
    expect(taskRepo(task({ project: null, labels: ["repo:wind-hunter"] }), projects, home, ["/Users/me/code/wind-hunter"])).toBe(
      "/Users/me/code/wind-hunter",
    );
  });

  it("leaves a task unrouted when its label names nothing known", () => {
    expect(taskRepo(task({ labels: ["repo:nope"] }), projects, home, ["/Users/me/code/app"])).toBeNull();
  });

  it("knows a mapped folder, however it is written", () => {
    expect(isMapped("/Users/me/code/herdr-miura", projects, home)).toBe(true);
    expect(isMapped("/Users/me/code/herdr-miura/", projects, home)).toBe(true);
    expect(isMapped("/Users/me/code/app", projects, home)).toBe(false);
    expect(isMapped(null, projects, home)).toBe(false);
  });

  it("keeps the tasks for one repo", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", project: "Life" }), task({ id: "c", labels: ["repo:herdr"] }), task({ id: "d", project: "Herdr", labels: ["repo:life"] })];
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

describe("comments in a prompt", () => {
  const comments = [
    { content: "The spec is here.\n", posted_at: "2026-11-12T10:00:00.000000Z" },
    { content: "And this.", posted_at: null },
  ];

  it("blocks them oldest first, each under its day", () => {
    expect(commentsBlock(comments)).toBe("Comment, 2026-11-12:\nThe spec is here.\n\nComment:\nAnd this.");
    expect(commentsBlock([])).toBe("");
  });

  it("fills {{task.comments}}, empty when there are none", () => {
    expect(fillTemplate("Do {{task.title}}.\n{{task.comments}}", task(), comments)).toBe(`Do Fix the filter.\n${commentsBlock(comments)}`);
    expect(fillTemplate("{{task.comments}}", task())).toBe("");
    // The whole block leaves them out: they go in only when asked for.
    expect(fillTemplate("{{task}}", task(), comments)).toBe(taskBlock(task()));
  });
});

describe("the status bar count and quick add", () => {
  it("counts the tasks due today or before", () => {
    const tasks = [task({ due: "2026-11-12" }), task({ due: "2026-11-13T09:00:00" }), task({ due: "2026-11-14" }), task({ due: null })];
    expect(dueBy(tasks, "2026-11-13")).toBe(2);
    expect(dueBy([], "2026-11-13")).toBe(0);
  });

  it("knows a missing token from a broken one", () => {
    expect(noToken("no Todoist token: add it to the keychain")).toBe(true);
    expect(noToken("Todoist refused the token (HTTP 401)")).toBe(false);
  });

  it("adds to the project mapped to the workspace's folder, else none", () => {
    const projects = { Herdr: "~/code/herdr-miura/", Notes: "/Users/me/notes" };
    expect(projectFor("/Users/me/code/herdr-miura", projects, "/Users/me")).toBe("Herdr");
    expect(projectFor("/Users/me/notes/", projects, "/Users/me")).toBe("Notes");
    expect(projectFor("/Users/me/code/other", projects, "/Users/me")).toBeNull();
    expect(projectFor(null, projects, "/Users/me")).toBeNull();
  });

  it("links a task as todoist.rs does", () => {
    expect(taskUrl("6gv")).toBe(task().url);
  });
});
