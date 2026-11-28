// The Doable panel: tasks read by `doable_tasks` (src-tauri's doable.rs,
// which holds the token), and a task turned into a prompt through a template
// from the prompt library. See docs/plan-doable.md.

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
  /// 1 (normal) to 4 (urgent): Doable's p4 to p1, turned round by `doable.rs`.
  priority: number;
  /// `YYYY-MM-DD`, or a date and time (`YYYY-MM-DDTHH:MM`), in local time.
  due: string | null;
  /// How it was typed: `tomorrow`, `every monday`.
  due_words: string | null;
  /// The repo a repo link on the task names, `owner/name` or `name`.
  repo: string | null;
  /// The Doable web app.
  url: string;
  /// Where it stands with Claude: `queued` (handed over on the Mac, so the
  /// queue starts it without asking), `running`, `left`, `you` or `done`.
  agent?: string | null;
}

export interface Tasks {
  tasks: Task[];
}

/// A task as `doable.rs` sends it: `due` the instant Doable keeps, in UTC.
type RawTask = Omit<Task, "due"> & { due: string | null; due_time: boolean };

const pad = (n: number) => String(n).padStart(2, "0");

/// Doable's due instant in local time: the day alone for a whole-day date
/// (kept as the local day's start, in UTC), else the day and the time.
export function localDue(due: string | null, hasTime: boolean): string | null {
  if (due === null) return null;
  const at = new Date(due);
  if (Number.isNaN(at.getTime())) return null;
  const day = localDay(at);
  return hasTime ? `${day}T${pad(at.getHours())}:${pad(at.getMinutes())}` : day;
}

export const readTasks = (view: string) =>
  invoke<{ tasks: RawTask[] }>("doable_tasks", { view }).then(({ tasks }) => ({
    tasks: tasks.map(({ due, due_time, ...task }) => ({ ...task, due: localDue(due, due_time) })),
  }));

/// Every project's name, the Inbox first, for the panel's view picker.
export const readProjects = () => invoke<string[]>("doable_projects");

// The panel's view: which tasks it lists. Null is the `doable.view` setting,
// which the status bar counts too. A view is one of Doable's own (`today`,
// `upcoming`, `inbox`) or `project:<name>`, `label:<name>`, `repo:<name>`.

/// Views beside the setting's and the projects, as view and label.
export const VIEWS: readonly (readonly [string, string])[] = [
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["inbox", "Inbox"],
];

/// The view of a project's tasks.
export const projectView = (name: string) => `project:${name}`;

/// The project a view lists, null for any other view.
export function viewedProject(view: string | null, projects: readonly string[]): string | null {
  return projects.find((name) => projectView(name) === view) ?? null;
}

const VIEW_KEY = "doable-view";

export function loadView(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(VIEW_KEY) || null;
  } catch {
    return null;
  }
}

export function saveView(view: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (view) storage?.setItem(VIEW_KEY, view);
    else storage?.removeItem(VIEW_KEY);
  } catch {
    // A view that does not stay picked is only a convenience lost.
  }
}

/// Completes a task in Doable, or reopens it when `done` is false (undo).
export const setDone = (task: string, done: boolean) => invoke<void>("doable_set_done", { task, done });

/// A task to add: `due` in words (`tomorrow 9am`), which Doable's quick add reads.
export interface NewTask {
  title: string;
  description?: string;
  due?: string;
}

/// Adds a task to the project named `project`, or the Inbox when null or unknown.
export const addTask = (task: NewTask, project: string | null) => invoke<Task>("doable_add", { task, project });

/// Adds a task typed as in Doable's quick add (`dentista tomorrow 10am p1 #Personal @agent`).
/// Without a date it is due today; left in the Inbox, it goes to `project` when that is set.
export function quickAdd(text: string, project: string | null, now = new Date()): Promise<Task> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return invoke<Task>("doable_quick_add", { text, project, today });
}

/// A parked ledger entry as a task: the note, and the repo and branch it was
/// left in, so it can be picked up from Doable alone.
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

/// Whether a failed read means no token is set (`doable.rs`'s `NoToken`), not a broken one.
export const noToken = (error: unknown) => String(error).startsWith("no Doable token");

/// Whether a failed read never reached Doable (`doable.rs`'s `Request`): often a passing
/// network drop, as on waking from sleep, so worth trying again soon.
export const unreachable = (error: unknown) => String(error).startsWith("could not reach Doable");

/// The Doable web app, as `doable.rs` gives it for every task: Doable has no page per task.
export const taskUrl = (_id: string) => "https://doable-chi.vercel.app/";

/// How many of `tasks` are due today or before, for the status bar.
export const dueBy = (tasks: readonly Task[], today: string) =>
  tasks.filter((task) => task.due !== null && task.due.slice(0, 10) <= today).length;

/// The prompt a task takes when none is named for it: a library prompt called this.
export const DEFAULT_TEMPLATE = "doable";

/// The task as a block a fresh agent can act on knowing nothing else.
export function taskBlock(task: Task): string {
  const facts = [
    task.project && `Project: ${task.project}`,
    task.labels.length > 0 && `Labels: ${task.labels.map((label) => `@${label}`).join(" ")}`,
    (task.due_words || task.due) && `Due: ${task.due_words || task.due}`,
    task.repo && `Repo: ${task.repo}`,
  ].filter(Boolean);
  return [
    `Doable task: ${task.title}`,
    ...(facts.length > 0 ? [facts.join(" · ")] : []),
    ...(task.description.trim() ? ["", task.description.trim()] : []),
    "",
    `Doable id: ${task.id}`,
  ].join("\n");
}

const FIELDS: Record<string, (task: Task) => string> = {
  title: (task) => task.title,
  description: (task) => task.description.trim(),
  id: (task) => task.id,
  url: (task) => task.url,
  project: (task) => task.project ?? "",
  labels: (task) => task.labels.join(", "),
  due: (task) => task.due_words || task.due || "",
  repo: (task) => task.repo ?? "",
};

const PLACEHOLDER = /\{\{\s*task(?:\.(\w+))?\s*\}\}/g;

/// `body` with the task in it: `{{task.title}}` and the other fields, or
/// `{{task}}` for the whole block. A body
/// with none of those takes the block for `$ARGUMENTS`, as Claude would, or
/// else below its text. An unknown field is left as written, so a typo shows
/// rather than vanishing.
export function fillTemplate(body: string | null, task: Task): string {
  const block = taskBlock(task);
  if (body === null || !body.trim()) return block;
  if (body.match(PLACEHOLDER)) {
    return body.replace(PLACEHOLDER, (whole, field?: string) => {
      if (field === undefined) return block;
      const value = FIELDS[field];
      return value ? value(task) : whole;
    });
  }
  if (body.includes("$ARGUMENTS")) return body.split("$ARGUMENTS").join(block);
  return `${body.trim()}\n\n${block}`;
}

/// The template a task opens with: a working prompt named as one of its
/// labels, else the one named `doable`, else none (the task alone).
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

/// How a task's date reads in the list, counted from `today` (`YYYY-MM-DD`):
/// Today, Tomorrow, a weekday within the week, else the day and month, with
/// its time if it has one, and how it repeats (`every monday`) when it does.
/// Not the words it was typed with alone: `tomorrow` stops holding a day later.
export function dueLabel(task: Task, today: string): string {
  if (task.due === null) return "";
  const [day, time] = task.due.split("T");
  const at = new Date(`${day}T00:00`);
  const days = Math.round((at.getTime() - new Date(`${today}T00:00`).getTime()) / 86_400_000);
  const name =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days > 1 && days < 7
          ? at.toLocaleDateString("en-GB", { weekday: "long" })
          : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(String(at.getFullYear()) !== today.slice(0, 4) && { year: "numeric" }) });
  const repeats = task.due_words?.trim().toLowerCase().startsWith("every") ? task.due_words.trim() : null;
  return [name, time, repeats && `· ${repeats}`].filter(Boolean).join(" ");
}

/// Whether a task's day is before `today` (`YYYY-MM-DD`).
export const overdue = (task: Task, today: string) => task.due !== null && task.due.slice(0, 10) < today;

/// Today in local time as `YYYY-MM-DD`, which is how `readTasks` gives due days.
export function localDay(now = new Date()): string {
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

// Repo routing: which repo a task is for. `doable.projects` maps Doable
// project names to folders, and a repo link on the task overrides that. The panel shows the focused workspace's tasks when its folder is
// mapped, and offers to send a task to its own repo's workspace.

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

/// The repo folder a task is for, or null when nothing routes it. A repo
/// link (`owner/name`, or `name`) wins over the project, naming a mapped
/// project or a folder by its last part (`folders` are the open workspaces');
/// one that names nothing known leaves the task unrouted rather than falling back.
export function taskRepo(task: Task, projects: Record<string, string>, home: string | null, folders: readonly string[] = []): string | null {
  if (task.repo) return folderNamed(base(task.repo), projects, folders, home);
  if (task.project === null) return null;
  const folder = projects[task.project] ?? Object.entries(projects).find(([project]) => project.toLowerCase() === task.project?.toLowerCase())?.[1];
  return folder === undefined ? null : expandFolder(folder, home);
}

/// The Doable project `doable.projects` maps to `folder`, null for none.
export function projectFor(folder: string | null, projects: Record<string, string>, home: string | null): string | null {
  if (folder === null) return null;
  const want = expandFolder(folder, home);
  return Object.entries(projects).find(([, mapped]) => expandFolder(mapped, home) === want)?.[0] ?? null;
}

/// Whether `folder` is one `doable.projects` maps a project to.
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
