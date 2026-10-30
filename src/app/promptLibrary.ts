// The prompt library: Claude Code's custom commands, read from
// `~/.claude/commands/` and the workspace folder's `.claude/commands/` by
// `prompt_library`, turned into the palette's entries here. A project prompt
// hides a global one of the same name. A file that cannot be used is kept as
// a broken entry with the reason, never dropped. See docs/plan-prompt-library.md.

import { invoke } from "@tauri-apps/api/core";
import { field, parseFrontmatter } from "./frontmatter";
import { AGENT_ARGS, AGENT_KIND, type Opened } from "./queue";

export type Scope = "project" | "global";
/// What a prompt is sent to: the focused agent, a fresh Claude in a new tab,
/// or the workspace's queue.
export type Action = "here" | "new-tab" | "queue";
export const ACTIONS: readonly Action[] = ["here", "new-tab", "queue"];

/// One file as `prompt_library` read it.
export interface RawFile {
  path: string;
  text: string | null;
  problem: string | null;
}

export interface RawFolder {
  dir: string;
  files: RawFile[];
  truncated: boolean;
}

export interface RawLibrary {
  global: RawFolder | null;
  project: RawFolder | null;
}

export interface Prompt {
  /// `<scope>:<path>`, unique in a library.
  key: string;
  /// The file's name without `.md`: what `/name` runs in Claude.
  name: string;
  scope: Scope;
  /// Relative to `dir`, the commands folder it is in.
  path: string;
  dir: string;
  /// The subfolder it sits in, shown beside the name; null at the top.
  group: string | null;
  description: string | null;
  argumentHint: string | null;
  /// `herdr.run`: what Enter does with it.
  run: Action | null;
  body: string;
  /// Why it cannot be sent; its actions are off.
  broken: string | null;
  /// A project prompt that hides a global one of its name.
  overrides: boolean;
}

export interface Library {
  /// Project prompts first, then global ones, each by name.
  prompts: Prompt[];
  /// Anything about the folders the list itself cannot show.
  notes: string[];
}

function parse(scope: Scope, dir: string, file: RawFile): Prompt {
  const parts = file.path.split("/");
  const prompt: Prompt = {
    key: `${scope}:${file.path}`,
    name: parts[parts.length - 1].replace(/\.md$/, ""),
    scope,
    path: file.path,
    dir,
    group: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
    description: null,
    argumentHint: null,
    run: null,
    body: "",
    broken: null,
    overrides: false,
  };
  if (file.text === null) return { ...prompt, broken: file.problem ?? "it could not be read" };
  const parsed = parseFrontmatter(file.text);
  if ("error" in parsed) return { ...prompt, body: file.text, broken: `its frontmatter does not parse: ${parsed.error}` };
  const run = field(parsed.fields, "herdr.run");
  const parsedPrompt = {
    ...prompt,
    description: field(parsed.fields, "description"),
    argumentHint: field(parsed.fields, "argument-hint"),
    body: parsed.body,
  };
  if (run !== null && !ACTIONS.includes(run as Action)) {
    return { ...parsedPrompt, broken: `herdr.run is “${run}”, not one of ${ACTIONS.join(", ")}` };
  }
  if (!parsed.body) return { ...parsedPrompt, run: run as Action | null, broken: "it has no prompt text" };
  return { ...parsedPrompt, run: run as Action | null };
}

/// One scope's entries by name: the first file of a name by path is used,
/// and any other file of that name is broken, naming the one it clashes with.
function scopeEntries(scope: Scope, folder: RawFolder | null): Prompt[] {
  if (!folder) return [];
  const first = new Map<string, Prompt>();
  const entries: Prompt[] = [];
  for (const file of [...folder.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const prompt = parse(scope, folder.dir, file);
    const taken = first.get(prompt.name);
    if (taken) {
      entries.push({ ...prompt, broken: `/${prompt.name} is already ${taken.path} in this folder` });
    } else {
      first.set(prompt.name, prompt);
      entries.push(prompt);
    }
  }
  return entries;
}

const byName = (a: Prompt, b: Prompt) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path);

/// The palette's entries from both folders. A global prompt whose name a
/// project file also has is left out, and the project entry says so.
export function buildLibrary(raw: RawLibrary): Library {
  const project = scopeEntries("project", raw.project);
  const names = new Set(project.map((prompt) => prompt.name));
  const global = scopeEntries("global", raw.global);
  const hidden = new Set(global.filter((prompt) => names.has(prompt.name)).map((prompt) => prompt.name));
  const notes = [raw.project, raw.global]
    .filter((folder): folder is RawFolder => !!folder?.truncated)
    .map((folder) => `Only the first ${folder.files.length} files of ${folder.dir} are read.`);
  return {
    prompts: [
      ...project.map((prompt) => ({ ...prompt, overrides: hidden.has(prompt.name) })).sort(byName),
      ...global.filter((prompt) => !names.has(prompt.name)).sort(byName),
    ],
    notes,
  };
}

/// The entries every word of `query` is found in (name, folder, description
/// or text), those whose name holds the first word first; otherwise in
/// library order, so project prompts stay ahead of global ones.
export function searchPrompts(prompts: readonly Prompt[], query: string): Prompt[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...prompts];
  const hay = (p: Prompt) => [p.name, p.group ?? "", p.description ?? "", p.body].join("\n").toLowerCase();
  const matches = prompts.filter((prompt) => {
    const text = hay(prompt);
    return words.every((word) => text.includes(word));
  });
  const inName = (p: Prompt) => (p.name.toLowerCase().includes(words[0]) ? 0 : 1);
  return matches
    .map((prompt, i) => ({ prompt, i }))
    .sort((a, b) => inName(a.prompt) - inName(b.prompt) || a.i - b.i)
    .map(({ prompt }) => prompt);
}

/// What Enter does: the file's `herdr.run`, else the focused agent when
/// there is one, else a new tab.
export function defaultAction(prompt: Prompt, hasAgent: boolean): Action {
  return prompt.run ?? (hasAgent ? "here" : "new-tab");
}

/// Why `action` cannot run on `prompt` now, or null when it can.
export function blocked(prompt: Prompt, action: Action, can: { agent: boolean; folder: boolean; queue: boolean }): string | null {
  if (prompt.broken) return prompt.broken;
  if (action === "here" && !can.agent) return "The focused pane has no agent.";
  if (action !== "here" && !can.folder) return "This workspace has no folder on this Mac.";
  if (action === "queue" && !can.queue) return "Another window has the queue.";
  return null;
}

/// What the name box keeps of what is typed: the `/name` a file can have.
export const promptName = (typed: string) =>
  typed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+/, "");

/// Why a new prompt called `name` cannot go in `scope`, or null when it can.
/// A project prompt may take a global one's name, as hiding it is what that
/// is for, but a global one would only be hidden itself.
export function nameTaken(prompts: readonly Prompt[], name: string, scope: Scope): string | null {
  const taken = prompts.find((prompt) => prompt.name === name);
  if (!taken) return null;
  if (taken.scope === scope) return `/${name} is already ${taken.path}.`;
  return scope === "global" ? `This project's /${name} would hide it.` : null;
}

/// A new prompt's file. The description goes in frontmatter, quoted when YAML
/// would read it as anything but a plain string.
export function promptFile(description: string, text: string): string {
  const summary = description.trim();
  const body = `${text.trim()}\n`;
  if (!summary) return body;
  const plain = /^[A-Za-z0-9][^:#"'\\]*$/.test(summary);
  return `---\ndescription: ${plain ? summary : JSON.stringify(summary)}\n---\n\n${body}`;
}

export const createPrompt = (directory: string | null, name: string, text: string) =>
  invoke<void>("prompt_create", { directory, name, text });

export const readLibrary = (directory: string | null) =>
  invoke<RawLibrary>("prompt_library", { directory }).then(buildLibrary);

export const sendPrompt = (pane: string, text: string) => invoke<void>("prompt_send", { pane, text });

/// Starts a fresh Claude in a new, unfocused tab of `workspaceId` at
/// `folder`, labelled `/<name>`, and sends it `text`. Its agent is named
/// `p<digits>`, apart from the queue's `q` names. An agent that is not ready
/// in time (a folder Claude has not trusted yet) keeps its tab, and the
/// promise fails saying the prompt was not sent.
export async function startInNewTab(workspaceId: string, folder: string, prompt: Prompt, text: string): Promise<void> {
  const name = `p${Date.now() % 1e9}`;
  const opened = await invoke<Opened>("queue_open", {
    workspaceId,
    directory: folder,
    label: `/${prompt.name}`,
    name,
    kind: AGENT_KIND,
    args: AGENT_ARGS,
  });
  if (!opened.ready) throw new Error(`/${prompt.name} was not sent: its new tab's agent is not ready (${opened.note ?? "no reason given"})`);
  await invoke<void>("queue_prompt", { name, text });
}
