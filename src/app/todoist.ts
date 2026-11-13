// The Todoist panel: tasks read by `todoist_tasks` (src-tauri's todoist.rs,
// which holds the token), and a task turned into a prompt through a template
// from the prompt library. See docs/plan-todoist.md.

import { invoke } from "@tauri-apps/api/core";
import type { Prompt } from "./promptLibrary";

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

const FIELDS: Record<string, (task: Task) => string> = {
  title: (task) => task.title,
  description: (task) => task.description.trim(),
  url: (task) => task.url,
  project: (task) => task.project ?? "",
  labels: (task) => task.labels.join(", "),
  due: (task) => task.due_words ?? "",
};

const PLACEHOLDER = /\{\{\s*task(?:\.(\w+))?\s*\}\}/g;

/// `body` with the task in it: `{{task.title}}` and the other fields, or
/// `{{task}}` for the whole block. A body with none of those takes the block
/// for `$ARGUMENTS`, as Claude would, or else below its text. An unknown field
/// is left as written, so a typo shows rather than vanishing.
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
