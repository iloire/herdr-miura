// Todoist automation, with care (docs/plan-todoist.md, idea 5). Nothing here
// starts an agent or writes anything by itself: `@agent` tasks are suggested
// in the queue's panel and added on a click, several tasks are queued as one
// prompt or one each when asked, and a cheap Claude's suggestions of a repo
// and a template change a task's labels only once accepted. Pure, apart from
// the two commands at the end.

import { invoke } from "@tauri-apps/api/core";
import type { Queue, TaskRef } from "./queue";
import { expandFolder, sortTasks, type Task, taskBlock, taskRepo } from "./todoist";

/// The label that offers a task to the queue: `@agent` in Todoist.
export const AGENT_LABEL = "agent";

export const isAgentTask = (task: Task) => task.labels.some((label) => label.toLowerCase() === AGENT_LABEL);

/// The Todoist filter that reads them, whatever `todoist.filter` lists.
export const AGENT_FILTER = `@${AGENT_LABEL}`;

/// A task as a queue item keeps it.
export const taskRef = (task: Task): TaskRef => ({ id: task.id, title: task.title });

/// The ids of the tasks a queue item came from, waiting, running or finished,
/// in any of `queues`: such a task is not suggested again.
export function queuedTaskIds(queues: readonly Queue[]): Set<string> {
  const ids = new Set<string>();
  for (const queue of queues) {
    for (const item of [...queue.items, ...queue.history]) {
      if (item.todoist) ids.add(item.todoist.id);
      for (const task of item.todoistBatch ?? []) ids.add(task.id);
    }
  }
  return ids;
}

/// The `@agent` tasks to suggest in `folder`'s queue: those routed to its
/// repo, or to none (they have no other home), not yet queued anywhere.
export function agentSuggestions(
  tasks: readonly Task[],
  queued: ReadonlySet<string>,
  folder: string,
  projects: Record<string, string>,
  home: string | null,
  folders: readonly string[] = [],
): Task[] {
  return sortTasks(
    tasks.filter((task) => {
      if (!isAgentTask(task) || queued.has(task.id)) return false;
      const repo = taskRepo(task, projects, home, folders);
      return repo === null || repo === folder;
    }),
  );
}

/// Several tasks as one prompt, one task block each, to run as one batch.
export function batchPrompt(tasks: readonly Task[]): string {
  if (tasks.length === 1) return taskBlock(tasks[0]);
  const blocks = tasks.map((task, index) => `## ${index + 1}. ${task.title}\n\n${taskBlock(task)}`);
  return [
    `These ${tasks.length} Todoist tasks are related: do them together in this session, one commit per task.`,
    ...blocks,
  ].join("\n\n");
}

// Triage: a repo and a template for each listed task, suggested by a cheap
// Claude and shown to accept or refuse. Accepting sets labels the panel
// already reads: `@repo:<name>` routes the task, and a label named as a
// library prompt picks its template.

export interface Suggestion {
  task: string;
  /// A repo's name, as `@repo:` takes it; null to leave it.
  repo: string | null;
  /// A library prompt's name; null to leave it.
  template: string | null;
  why: string;
}

/// Tasks past this are left out of one triage run: a cheap model, a short answer.
export const TRIAGE_MAX = 40;
const DESCRIPTION_MAX = 300;

/// The repos the triage run may choose from, by the name `@repo:` takes: the
/// folders `todoist.projects` maps and the open workspaces', once each.
export function triageRepos(projects: Record<string, string>, home: string | null, folders: readonly string[]): string[] {
  const all = [...Object.values(projects), ...folders].map((folder) => repoName(expandFolder(folder, home)));
  return [...new Set(all.filter(Boolean))].sort();
}

/// A repo folder's name, as `@repo:` takes it.
export const repoName = (folder: string) => folder.split("/").pop() ?? folder;

/// The question for the triage run: the tasks, the repos and the templates
/// it may choose from, and the answer's shape.
export function triagePrompt(tasks: readonly Task[], repos: readonly string[], templates: readonly Template[]): string {
  const listed = tasks.slice(0, TRIAGE_MAX).map((task) => ({
    id: task.id,
    title: task.title,
    ...(task.description.trim() && { description: task.description.trim().slice(0, DESCRIPTION_MAX) }),
    ...(task.project && { project: task.project }),
    ...(task.labels.length > 0 && { labels: task.labels }),
  }));
  return [
    "You triage Todoist tasks for a developer who hands them to coding agents. For each task, pick the code repo it",
    "is most likely about and the prompt template that fits it best, from the lists below only. Use null when none",
    "fits or you are unsure; a wrong guess is worse than null.",
    "",
    `Repos: ${JSON.stringify(repos)}`,
    `Templates: ${JSON.stringify(templates.map((template) => (template.description ? `${template.name}: ${template.description}` : template.name)))}`,
    "",
    "Tasks:",
    JSON.stringify(listed, null, 1),
    "",
    'Answer with a JSON array only, no prose and no code fence, one object per task:',
    '[{"id": "<task id>", "repo": "<repo or null>", "template": "<template name or null>", "why": "<a few words>"}]',
  ].join("\n");
}

/// A template the triage run may suggest: a library prompt's name, and what it is for.
export interface Template {
  name: string;
  description: string | null;
}

/// The suggestions in the triage run's answer: only for tasks it was asked
/// about, only naming repos and templates it was offered (any case, given
/// back as offered), and only those that suggest something.
export function parseSuggestions(
  answer: string,
  tasks: readonly Task[],
  repos: readonly string[],
  templates: readonly string[],
): Suggestion[] {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = new Set(tasks.map((task) => task.id));
  const pick = (value: unknown, from: readonly string[]) =>
    typeof value === "string" ? (from.find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? null) : null;
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, repo, template, why } = entry as Record<string, unknown>;
    const task = typeof id === "string" || typeof id === "number" ? String(id) : "";
    if (!ids.has(task) || seen.has(task)) continue;
    seen.add(task);
    const suggestion = {
      task,
      repo: pick(repo, repos),
      template: pick(template, templates),
      why: typeof why === "string" ? why.trim().slice(0, 200) : "",
    };
    if (suggestion.repo || suggestion.template) suggestions.push(suggestion);
  }
  return suggestions;
}

const REPO_LABEL = /^repo:/i;

/// The labels `task` takes when `suggestion` is accepted, or null when it
/// would change nothing. The repo goes in as `repo:<name>`, replacing any
/// such label, unless `routed` (the repo it goes to now, by name) is it
/// already. The template goes in as its name, replacing a label that names
/// another of `templates`, as the panel picks a template by label.
export function acceptedLabels(task: Task, suggestion: Suggestion, templates: readonly string[], routed: string | null): string[] | null {
  let labels = [...task.labels];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { repo, template } = suggestion;
  if (repo && !(routed && same(routed, repo))) {
    labels = [...labels.filter((label) => !REPO_LABEL.test(label)), `repo:${repo}`];
  }
  if (template && !labels.some((label) => same(label, template))) {
    // `@agent` stays: it offers the task to the queue, whatever else it means.
    const other = (label: string) => !same(label, AGENT_LABEL) && templates.some((name) => same(name, label));
    labels = [...labels.filter((label) => !other(label)), template];
  }
  const changed = labels.length !== task.labels.length || labels.some((label, index) => label !== task.labels[index]);
  return changed ? labels : null;
}

/// Asks the cheap Claude (`triage.rs`): Haiku, no tools, nothing it can change.
export const askTriage = (prompt: string) => invoke<string>("todoist_triage", { prompt });

/// Sets a task's labels, all of them, as an accepted suggestion.
export const setLabels = (task: string, labels: readonly string[]) => invoke<void>("todoist_set_labels", { task, labels });
