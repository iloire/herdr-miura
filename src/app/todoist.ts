// The Todoist panel: tasks read by `todoist_tasks` (src-tauri's todoist.rs,
// which holds the token), and a task turned into a prompt through a template
// from the prompt library. See docs/plan-todoist.md.

import { invoke } from "@tauri-apps/api/core";
import { tildePath } from "./folder";
import type { Outcome } from "./ledger";
import type { Prompt } from "./promptLibrary";
import { title } from "./queue";

export interface Task {
  id: string;
  title: string;
  description: string;
  project: string | null;
  labels: string[];
  /// Todoist's 1 (normal) to 4 (urgent).
  priority: number;
  /// `YYYY-MM-DD`, or a date and time.
  due: string | null;
  /// How Todoist says it: `24 Sep`, `every day`.
  due_words: string | null;
  url: string;
}

export interface Tasks {
  tasks: Task[];
  truncated: boolean;
}

export const readTasks = (filter: string) => invoke<Tasks>("todoist_tasks", { filter });

/// A comment on a task.
export interface Comment {
  content: string;
  posted_at: string | null;
}

export const readComments = (task: string) => invoke<Comment[]>("todoist_comments", { task });

/// Completes a task in Todoist, or reopens it when `done` is false (undo).
export const setDone = (task: string, done: boolean) => invoke<void>("todoist_set_done", { task, done });

/// A task to add: `due` in Todoist's own words (`tomorrow 9am`), which it reads.
export interface NewTask {
  title: string;
  description?: string;
  due?: string;
}

/// Adds a task to the project named `project`, or the Inbox when null or unknown.
export const addTask = (task: NewTask, project: string | null) => invoke<Task>("todoist_add", { task, project });

/// A parked ledger entry as a task: the note, and the repo and branch it was
/// left in, so it can be picked up from Todoist alone.
export function parkedTask(outcome: Outcome, home: string | null): NewTask {
  const [first = "", ...rest] = outcome.note.trim().split("\n");
  const facts = [
    `Left for later by an agent in Herdr Miura, ${outcome.at}.`,
    outcome.home && `Repo: \`${tildePath(outcome.home, home)}\``,
    outcome.branch && `Branch: \`${outcome.branch}\``,
  ];
  const description = [rest.join("\n").trim(), facts.filter(Boolean).join("\n")].filter(Boolean).join("\n\n");
  return { title: first.trim() || "Left for later by an agent", description };
}

/// A waiting queue prompt as a dated task holding it whole, to queue again when due.
export function queuedTask(prompt: string, folder: string, due: string, home: string | null): NewTask {
  const where = `A prompt from Herdr Miura's queue for \`${tildePath(folder, home)}\`, to queue again when it is due.`;
  return { title: title(prompt, 200) || "A queued prompt", description: `${where}\n\n${prompt.trim()}`, due: due.trim() };
}

/// Whether a failed read means no token is set (`todoist.rs`'s `NoToken`), not a broken one.
export const noToken = (error: unknown) => String(error).startsWith("no Todoist token");

/// A task's page in Todoist, as `todoist.rs` shapes it.
export const taskUrl = (id: string) => `https://app.todoist.com/app/task/${id}`;

/// How many of `tasks` are due today or before, for the status bar.
export const dueBy = (tasks: readonly Task[], today: string) =>
  tasks.filter((task) => task.due !== null && task.due.slice(0, 10) <= today).length;

/// The comments as a block for a prompt, oldest first, each under its day.
export function commentsBlock(comments: readonly Comment[]): string {
  return comments
    .map((comment) => {
      const day = comment.posted_at?.slice(0, 10);
      return `${day ? `Comment, ${day}:` : "Comment:"}\n${comment.content.trim()}`;
    })
    .join("\n\n");
}

/// The prompt a task takes when none is named for it: a library prompt called this.
export const DEFAULT_TEMPLATE = "todoist";

/// The task as a block a fresh agent can act on knowing nothing else.
export function taskBlock(task: Task): string {
  const facts = [
    task.project && `Project: ${task.project}`,
    task.labels.length > 0 && `Labels: ${task.labels.map((label) => `@${label}`).join(" ")}`,
    task.due_words && `Due: ${task.due_words}`,
  ].filter(Boolean);
  return [
    `Todoist task: ${task.title}`,
    ...(facts.length > 0 ? [facts.join(" · ")] : []),
    ...(task.description.trim() ? ["", task.description.trim()] : []),
    "",
    task.url,
  ].join("\n");
}

const FIELDS: Record<string, (task: Task, comments: readonly Comment[]) => string> = {
  title: (task) => task.title,
  description: (task) => task.description.trim(),
  url: (task) => task.url,
  project: (task) => task.project ?? "",
  labels: (task) => task.labels.join(", "),
  due: (task) => task.due_words ?? "",
  comments: (_, comments) => commentsBlock(comments),
};

const PLACEHOLDER = /\{\{\s*task(?:\.(\w+))?\s*\}\}/g;

/// `body` with the task in it: `{{task.title}}` and the other fields, or
/// `{{task}}` for the whole block; `{{task.comments}}` takes `comments`. A body
/// with none of those takes the block for `$ARGUMENTS`, as Claude would, or
/// else below its text. An unknown field is left as written, so a typo shows
/// rather than vanishing.
export function fillTemplate(body: string | null, task: Task, comments: readonly Comment[] = []): string {
  const block = taskBlock(task);
  if (body === null || !body.trim()) return block;
  if (body.match(PLACEHOLDER)) {
    return body.replace(PLACEHOLDER, (whole, field?: string) => {
      if (field === undefined) return block;
      const value = FIELDS[field];
      return value ? value(task, comments) : whole;
    });
  }
  if (body.includes("$ARGUMENTS")) return body.split("$ARGUMENTS").join(block);
  return `${body.trim()}\n\n${block}`;
}

/// The template a task opens with: a working prompt named as one of its
/// labels, else the one named `todoist`, else none (the task alone).
export function templateFor(task: Task, prompts: readonly Prompt[]): Prompt | null {
  const usable = prompts.filter((prompt) => !prompt.broken);
  const labels = task.labels.map((label) => label.toLowerCase());
  return (
    usable.find((prompt) => labels.includes(prompt.name.toLowerCase())) ??
    usable.find((prompt) => prompt.name === DEFAULT_TEMPLATE) ??
    null
  );
}

/// Dated tasks first, earliest first, then by priority, urgent first.
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.due !== b.due) {
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return b.priority - a.priority;
  });
}

/// Whether a task's day is before `today` (`YYYY-MM-DD`).
export const overdue = (task: Task, today: string) => task.due !== null && task.due.slice(0, 10) < today;

/// Today in local time as `YYYY-MM-DD`, which is how Todoist dates read.
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/// The tasks every word of `query` is found in: title, description, project or a label.
export function matchingTasks(tasks: readonly Task[], query: string): Task[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...tasks];
  return tasks.filter((task) => {
    const hay = [task.title, task.description, task.project ?? "", ...task.labels].join("\n").toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

// Repo routing: which repo a task is for. `todoist.projects` maps Todoist
// project names to folders, and a `@repo:<name>` label overrides that for one
// task. The panel shows the focused workspace's tasks when its folder is
// mapped, and offers to send a task to its own repo's workspace.

/// The label that names a task's repo: `repo:herdr-miura`.
const REPO_LABEL = /^repo:(.+)$/i;

/// A folder as the settings write it, `~` for home, with no trailing slash.
export function expandFolder(folder: string, home: string | null): string {
  const root = home?.replace(/\/+$/, "") ?? null;
  const full = root && (folder === "~" || folder.startsWith("~/")) ? `${root}${folder.slice(1)}` : folder;
  return full.length > 1 ? full.replace(/\/+$/, "") : full;
}

const base = (folder: string) => folder.split("/").pop() ?? folder;

/// The folder `name` stands for: a mapped project's (any case), else a known
/// folder's last part. Mapped folders come before open ones.
function folderNamed(name: string, projects: Record<string, string>, folders: readonly string[], home: string | null): string | null {
  const want = name.trim().toLowerCase();
  const mapped = Object.entries(projects).map(([project, folder]) => [project, expandFolder(folder, home)] as const);
  const byProject = mapped.find(([project]) => project.toLowerCase() === want);
  if (byProject) return byProject[1];
  const known = [...mapped.map(([, folder]) => folder), ...folders.map((folder) => expandFolder(folder, home))];
  return known.find((folder) => base(folder).toLowerCase() === want) ?? null;
}

/// The repo folder a task is for, or null when nothing routes it. A
/// `@repo:<name>` label wins over the project, naming a mapped project or a
/// folder by its last part (`folders` are the open workspaces'); one that names
/// nothing known leaves the task unrouted rather than falling back.
export function taskRepo(task: Task, projects: Record<string, string>, home: string | null, folders: readonly string[] = []): string | null {
  for (const label of task.labels) {
    const named = label.match(REPO_LABEL);
    if (named) return folderNamed(named[1], projects, folders, home);
  }
  if (task.project === null) return null;
  const folder = projects[task.project] ?? Object.entries(projects).find(([project]) => project.toLowerCase() === task.project?.toLowerCase())?.[1];
  return folder === undefined ? null : expandFolder(folder, home);
}

/// The Todoist project `todoist.projects` maps to `folder`, null for none.
export function projectFor(folder: string | null, projects: Record<string, string>, home: string | null): string | null {
  if (folder === null) return null;
  const want = expandFolder(folder, home);
  return Object.entries(projects).find(([, mapped]) => expandFolder(mapped, home) === want)?.[0] ?? null;
}

/// Whether `folder` is one `todoist.projects` maps a project to.
export const isMapped = (folder: string | null, projects: Record<string, string>, home: string | null) =>
  projectFor(folder, projects, home) !== null;

/// The tasks for `folder`'s repo.
export function tasksFor(
  tasks: readonly Task[],
  folder: string,
  projects: Record<string, string>,
  home: string | null,
  folders: readonly string[] = [],
): Task[] {
  const want = expandFolder(folder, home);
  return tasks.filter((task) => taskRepo(task, projects, home, folders) === want);
}

/// An open workspace a task can be sent to.
export interface Target {
  workspaceId: string;
  label: string;
  /// Its repo's folder on disk.
  folder: string;
  /// Its queue's folder, which differs from `folder` for a workspace split off a tab.
  queueFolder: string;
}

/// Where to send a task whose repo is not the focused workspace's: the open
/// workspace on that repo, preferring the one that keeps its main queue there.
/// Null when the task is for the focused repo, routes nowhere, or no workspace
/// on its repo is open.
export function sendTarget(repo: string | null, focused: string | null, targets: readonly Target[]): Target | null {
  if (repo === null || repo === focused) return null;
  const open = targets.filter((target) => target.folder === repo);
  return open.find((target) => target.queueFolder === target.folder) ?? open[0] ?? null;
}
