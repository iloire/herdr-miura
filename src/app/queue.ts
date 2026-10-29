// A prompt queue per workspace folder: prompts handed to a workspace start
// one at a time, each in a new tab and a fresh agent, the next only once no
// agent there is working, blocked or looping. Herdr has no queue, so this is
// the window's: `queue.rs` keeps the file and starts agents; what runs when
// is decided here, by `step`, from the daemon snapshot alone.

import { invoke } from "@tauri-apps/api/core";
import { workspaceDirectory } from "../changes/counts";
import type { Agent, Snapshot, Workspace } from "../protocol";
import { loopTag } from "./attention";

// These become `queue.*` settings once `config-tauri.toml` exists (docs/plan-settings.md).
/// The `--kind` each queued prompt's agent is started with.
export const AGENT_KIND = "claude";
/// Extra arguments for that agent.
export const AGENT_ARGS: string[] = [];
/// Appended to every prompt while "commit when done" is ticked, so each item
/// leaves a clean tree and the next starts from its commit.
export const COMMIT_SUFFIX = "When you are done, commit your work: stage only the files you changed.";
/// How long an agent must stay done or idle before its item counts as finished,
/// so a pause between tool calls does not end it.
export const FINISH_DEBOUNCE_MS = 5000;
/// How long an inbox prompt for a workspace that is not open may wait for it
/// before it is moved to `queue-inbox/rejected/`.
export const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/// How long a newly opened tab may be missing from the snapshot before its item
/// counts as closed: the snapshot that shows it can lag the CLI's answer.
const OPEN_GRACE_MS = 15_000;
const HISTORY = 20;

/// `queued` → `starting` (tab and agent being made) → `waiting` (agent not
/// ready, e.g. asking to trust the folder) → `prompting` → `running` → `done`,
/// or `failed` / `stopped`, which pause the queue.
export type ItemState = "queued" | "starting" | "waiting" | "prompting" | "running" | "done" | "failed" | "stopped";

export interface Item {
  /// Unique across queues; also the agent's name in Herdr.
  id: string;
  /// Its number within its queue, as its tab and card show it: "#2".
  n: number;
  prompt: string;
  state: ItemState;
  added: number;
  started?: number;
  /// When `queue_open` answered, from which the open grace runs.
  opened?: number;
  finished?: number;
  tabId?: string;
  paneId?: string;
  /// The checkout's commit when the item started, to count what it committed.
  head?: string;
  commits?: number;
  /// Why it failed or stopped, or what held its agent up.
  reason?: string;
  /// Since when its agent has been done or idle without a break.
  quietSince?: number;
  /// Set when it came through the inbox (an agent's `herdr-queue add`), not
  /// the panel: who sent it, in their words, or "" when they did not say.
  source?: string;
}

export interface Queue {
  folder: string;
  paused: { reason: string } | null;
  /// Pause once the running item finishes.
  stopAfter: boolean;
  commitSuffix: boolean;
  requireClean: boolean;
  nextN: number;
  /// Queued items in order, and the one in progress.
  items: Item[];
  /// Finished items, newest first.
  history: Item[];
}

export interface QueueFile {
  version: 1;
  seq: number;
  queues: Record<string, Queue>;
}

export const EMPTY_FILE: QueueFile = { version: 1, seq: 0, queues: {} };

const ACTIVE: ReadonlySet<ItemState> = new Set(["starting", "waiting", "prompting", "running"]);

export const isActive = (item: Item) => ACTIVE.has(item.state);

/// Queues are this Mac's: the CLI that starts agents runs here.
export const queueKey = (folder: string) => `local:${folder}`;

/// The folder a workspace was opened on, where its queue's agents start. The
/// queue is kept by this folder, so it must not follow the focused tab: when
/// herdr names no folder, it is the one most of the workspace's tabs are in,
/// a tie going to the lowest tab number, so one agent in another checkout or a
/// restart that focuses another tab never shows a different, empty queue.
export function workspaceFolder(workspace: Workspace, snapshot: Snapshot): string | null {
  if (workspace.new_workspace_cwd) return workspace.new_workspace_cwd;
  const tabs = snapshot.tabs
    .filter((tab) => tab.workspace_id === workspace.workspace_id)
    .sort((a, b) => a.number - b.number);
  const count = new Map<string, number>();
  for (const tab of tabs) {
    const pane = snapshot.panes.find((p) => p.tab_id === tab.tab_id);
    const folder = pane?.cwd || pane?.foreground_cwd;
    if (folder) count.set(folder, (count.get(folder) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [folder, n] of count) if (best === null || n > (count.get(best) ?? 0)) best = folder;
  return best ?? workspaceDirectory(workspace, snapshot);
}

export function emptyQueue(folder: string): Queue {
  return {
    folder,
    paused: null,
    stopAfter: false,
    commitSuffix: true,
    requireClean: true,
    nextN: 1,
    items: [],
    history: [],
  };
}

/// A prompt's title: its first line with text, cut to `max` characters.
export function title(prompt: string, max = 60): string {
  const line = prompt.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const tabLabel = (item: Item) => `⧗ ${item.n} · ${title(item.prompt, 40)}`;

/// What the agent is sent: the prompt, then the commit request when asked for.
export function promptText(item: Item, queue: Queue): string {
  return queue.commitSuffix ? `${item.prompt.trim()}\n\n${COMMIT_SUFFIX}` : item.prompt.trim();
}

/// What `step` sees of the daemon for one queue.
export interface View {
  now: number;
  /// The workspaces opened on the queue's folder, in the daemon's order.
  workspaces: Workspace[];
  /// Every agent in those workspaces.
  agents: Agent[];
  /// Every pane the snapshot shows.
  panes: ReadonlySet<string>;
}

export function viewOf(queue: Queue, snapshot: Snapshot, now: number): View {
  const workspaces = snapshot.workspaces.filter((w) => workspaceFolder(w, snapshot) === queue.folder);
  const ids = new Set(workspaces.map((w) => w.workspace_id));
  return {
    now,
    workspaces,
    agents: snapshot.agents.filter((a) => ids.has(a.workspace_id)),
    panes: new Set(snapshot.panes.map((p) => p.pane_id)),
  };
}

/// Work for the window to carry out: open an item's tab and agent, prompt an
/// agent that has become ready, or count what a finished item committed.
export type Effect =
  | { kind: "open"; item: Item; workspaceId: string }
  | { kind: "prompt"; item: Item }
  | { kind: "finished"; item: Item };

const busy = (agent: Agent) =>
  agent.agent_status === "working" || agent.agent_status === "blocked" || loopTag(agent) !== null;

/// What one queue does next. Returns the same queue object when nothing
/// changes, and at most one effect: never two items at once.
export function step(queue: Queue, view: View): { queue: Queue; effect: Effect | null } {
  const same = { queue, effect: null };
  const { now } = view;
  const active = queue.items.find(isActive);
  if (active) {
    // `queue_open` or `queue_prompt` is in flight; its answer moves the item on.
    if (active.state === "starting" || active.state === "prompting") return same;
    if (!active.paneId || !view.panes.has(active.paneId)) {
      if (active.opened && now - active.opened < OPEN_GRACE_MS) return same;
      return { queue: end(queue, active.id, "stopped", now, "its tab was closed"), effect: null };
    }
    const agent = view.agents.find((a) => a.pane_id === active.paneId);
    if (active.state === "waiting") {
      // Herdr refused to start it, so no agent will ever become ready there.
      if (!agent) {
        if (active.opened && now - active.opened < OPEN_GRACE_MS) return same;
        const reason = active.reason ? `its agent never started: ${active.reason}` : "its agent never started";
        return { queue: end(queue, active.id, "failed", now, reason), effect: null };
      }
      if (agent.agent_status !== "idle" && agent.agent_status !== "done") return same;
      const item = { ...active, state: "prompting" as const, reason: undefined };
      return { queue: replace(queue, item), effect: { kind: "prompt", item } };
    }
    // Running. A missing agent counts as quiet, so one that exited ends it too.
    const quiet = !agent || !busy(agent);
    if (!quiet) return active.quietSince === undefined ? same : { queue: replace(queue, { ...active, quietSince: undefined }), effect: null };
    if (active.quietSince === undefined) return { queue: replace(queue, { ...active, quietSince: now }), effect: null };
    if (now - active.quietSince < FINISH_DEBOUNCE_MS) return same;
    if (!agent) return { queue: end(queue, active.id, "stopped", now, "its agent exited"), effect: null };
    const ended = end(queue, active.id, "done", now);
    const finished = ended.history[0];
    const next = queue.stopAfter
      ? { ...ended, stopAfter: false, paused: { reason: `Stopped after #${active.n}, as asked.` } }
      : ended;
    return { queue: next, effect: { kind: "finished", item: finished } };
  }
  if (queue.paused) return same;
  const next = queue.items.find((item) => item.state === "queued");
  const workspace = view.workspaces[0];
  if (!next || !workspace || view.agents.some(busy)) return same;
  const item = { ...next, state: "starting" as const, started: now };
  return { queue: replace(queue, item), effect: { kind: "open", item, workspaceId: workspace.workspace_id } };
}

/// The queue with `item` in place of the one with its id.
export function replace(queue: Queue, item: Item): Queue {
  return { ...queue, items: queue.items.map((i) => (i.id === item.id ? item : i)) };
}

export function patchItem(queue: Queue, id: string, patch: Partial<Item>): Queue {
  const item = queue.items.find((i) => i.id === id);
  return item ? replace(queue, { ...item, ...patch }) : queue;
}

/// Moves an item into the history. Anything but `done` pauses the queue with
/// the reason, since what went wrong is for you to look at, not to guess past.
export function end(queue: Queue, id: string, state: "done" | "failed" | "stopped", now: number, reason?: string): Queue {
  const item = queue.items.find((i) => i.id === id);
  if (!item) return queue;
  const ended: Item = { ...item, state, finished: now, reason, quietSince: undefined };
  return {
    ...queue,
    items: queue.items.filter((i) => i.id !== id),
    history: [ended, ...queue.history].slice(0, HISTORY),
    paused: state === "done" ? queue.paused : { reason: `#${item.n} ${reason ?? state}.` },
  };
}

/// Takes the item in progress out of the queue by your hand, leaving its tab
/// and agent as they are. Unlike `end`, it does not pause, so the next prompt
/// starts once nothing in the workspace is busy. Not while `queue_open` or
/// `queue_prompt` is in flight, whose answer would find no item.
export function dropItem(queue: Queue, id: string, now: number): Queue {
  const item = queue.items.find((i) => i.id === id);
  if (!item || !isActive(item) || item.state === "starting" || item.state === "prompting") return queue;
  return { ...end(queue, id, "stopped", now, "removed by you"), paused: queue.paused };
}

/// Puts a `starting` item back at its place and pauses, for a start refused
/// before anything was made, such as on a dirty checkout.
export function holdBack(queue: Queue, id: string, reason: string): Queue {
  return { ...patchItem(queue, id, { state: "queued", started: undefined }), paused: { reason } };
}

/// A file read at launch: an item that was being started when the window
/// closed may have left a tab or not, so it fails and pauses its queue; one
/// being prompted most likely got its prompt, so it runs.
export function recover(file: QueueFile, now: number): QueueFile {
  const queues: Record<string, Queue> = {};
  for (const [key, queue] of Object.entries(file.queues)) {
    let next = queue;
    for (const item of queue.items) {
      if (item.state === "starting") next = end(next, item.id, "failed", now, "was interrupted when the app closed");
      if (item.state === "prompting") next = patchItem(next, item.id, { state: "running" });
    }
    queues[key] = next;
  }
  return { ...file, queues };
}

/// Adds a prompt at the end, or at the front of what is waiting.
export function addItem(
  file: QueueFile,
  folder: string,
  prompt: string,
  front: boolean,
  now: number,
  source?: string,
): QueueFile {
  const key = queueKey(folder);
  const queue = file.queues[key] ?? emptyQueue(folder);
  const seq = file.seq + 1;
  const item: Item = { id: `q${seq}`, n: queue.nextN, prompt: prompt.trim(), state: "queued", added: now };
  if (source !== undefined) item.source = source;
  const at = front ? queue.items.filter(isActive).length : queue.items.length;
  const items = [...queue.items.slice(0, at), item, ...queue.items.slice(at)];
  return { ...file, seq, queues: { ...file.queues, [key]: { ...queue, nextN: queue.nextN + 1, items } } };
}

/// A prompt another program left in `queue-inbox/`, as `queue_inbox_list`
/// read and checked it.
export interface InboxEntry {
  name: string;
  workspace_id: string | null;
  folder: string | null;
  prompt: string;
  front: boolean;
  source: string | null;
  age_ms: number;
}

/// The folder whose queue an inbox prompt joins: its workspace's while the
/// snapshot shows that workspace, else the folder it names, if any.
export function inboxFolder(entry: InboxEntry, snapshot: Snapshot): string | null {
  const workspace = snapshot.workspaces.find((w) => w.workspace_id === entry.workspace_id);
  return (workspace && workspaceFolder(workspace, snapshot)) || entry.folder;
}

/// Adds the inbox's prompts to their queues, in the order given. Returns the
/// new file, the entries it added (to delete once that file is saved), and
/// those to reject: a workspace not open after `INBOX_MAX_AGE_MS`. Any other
/// entry is left for a later tick.
export function takeInbox(
  file: QueueFile,
  entries: InboxEntry[],
  snapshot: Snapshot,
  now: number,
): { file: QueueFile; added: string[]; rejected: { name: string; reason: string }[] } {
  const added: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const entry of entries) {
    const folder = inboxFolder(entry, snapshot);
    if (folder) {
      file = addItem(file, folder, entry.prompt, entry.front, now, entry.source ?? "");
      added.push(entry.name);
    } else if (entry.age_ms > INBOX_MAX_AGE_MS) {
      rejected.push({ name: entry.name, reason: `Workspace ${entry.workspace_id} was not open within 24 hours.` });
    }
  }
  return { file, added, rejected };
}

/// Moves a waiting item `delta` places among the waiting ones.
export function moveItem(queue: Queue, id: string, delta: number): Queue {
  const waiting = queue.items.filter((i) => i.state === "queued");
  const from = waiting.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= waiting.length) return queue;
  const reordered = [...waiting];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return { ...queue, items: [...queue.items.filter(isActive), ...reordered] };
}

/// Removes a waiting item; returns the queue and where it was, for an undo.
export function removeItem(queue: Queue, id: string): { queue: Queue; index: number } {
  const index = queue.items.findIndex((i) => i.id === id && i.state === "queued");
  if (index < 0) return { queue, index };
  return { queue: { ...queue, items: queue.items.filter((_, i) => i !== index) }, index };
}

export function restoreItem(queue: Queue, item: Item, index: number): Queue {
  const items = [...queue.items];
  items.splice(Math.min(index, items.length), 0, item);
  return { ...queue, items };
}

/// Which queue item a tab runs, and where it stands in its queue.
export function itemOfTab(
  file: QueueFile | null,
  tabId: string,
): { item: Item; position: number; total: number; next: Item | null } | null {
  for (const queue of Object.values(file?.queues ?? {})) {
    const index = queue.items.findIndex((i) => i.tabId === tabId);
    if (index >= 0) {
      const done = queue.history.filter((i) => i.state === "done").length;
      const next = queue.items.find((i) => i.state === "queued") ?? null;
      return { item: queue.items[index], position: done + 1, total: done + queue.items.length, next };
    }
  }
  return null;
}

/// A queue's one-line state, as the card and status bar's hover say it.
export function summary(queue: Queue): string {
  const waiting = queue.items.filter((i) => i.state === "queued").length;
  const active = queue.items.find(isActive);
  const parts = [
    active && `#${active.n} ${active.state === "waiting" ? "waiting for its agent" : "running"}`,
    `${waiting} waiting`,
    queue.paused && `paused: ${queue.paused.reason}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

export const loadQueue = () => invoke<QueueFile>("queue_load");
export const saveQueue = (data: QueueFile) => invoke<void>("queue_save", { data });

export const readInbox = () => invoke<InboxEntry[]>("queue_inbox_list");
/// Deletes an inbox file, or with a reason moves it to `rejected/`.
export const settleInbox = (name: string, reason: string | null) =>
  invoke<void>("queue_inbox_settle", { name, reason });

export interface Opened {
  tab_id: string;
  pane_id: string;
  ready: boolean;
  note: string | null;
  head: string | null;
}

export const openItem = (workspaceId: string, item: Item, folder: string) =>
  invoke<Opened>("queue_open", {
    workspaceId,
    directory: folder,
    label: tabLabel(item),
    name: item.id,
    kind: AGENT_KIND,
    args: AGENT_ARGS,
  });

export const promptItem = (item: Item, queue: Queue) =>
  invoke<void>("queue_prompt", { name: item.id, text: promptText(item, queue) });

export const countCommits = (folder: string, since: string) =>
  invoke<number>("queue_commits", { directory: folder, since });
