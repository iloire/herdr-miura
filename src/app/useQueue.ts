// The window's side of the prompt queue: loads the file, runs `step` for
// every queue on each snapshot and once a second (for the finish debounce),
// carries out what it asks for, and saves after every change. Once a second it
// also takes what other programs left in the queue's inbox (`herdr-queue add`).

import { getIdentifier } from "@tauri-apps/api/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readCounts } from "../changes/counts";
import { DEV_BRANCH } from "../components/DevBar";
import type { Snapshot } from "../protocol";
import type { Controller } from "./controller";
import {
  addItem,
  bringBack,
  countCommits,
  dropItem,
  type Effect,
  emptyQueue,
  end,
  type FolderOf,
  foldSplitQueues,
  holdBack,
  isAway,
  type Item,
  loadQueue,
  moveItem,
  type Opened,
  openItem,
  openWorktree,
  patchItem,
  promptItem,
  type Queue,
  type QueueFile,
  queueDirectory,
  queueKey,
  readInbox,
  recover,
  removeItem,
  restoreItem,
  saveQueue,
  sendAway,
  settleInbox,
  step,
  takeInbox,
  viewOf,
  worktreePath,
} from "./queue";

const TICK_MS = 1000;
const LOAD_RETRY_MS = 5000;
/// The app id of the window in daily use. A dev build started with another
/// one (`com.herdr.tauri.dev`, see CLAUDE.md) keeps a queue of its own; one
/// on a feature branch with this id has no queue at all, so the daily queue
/// is only ever run by `main`'s code (Stable, in daily use).
const DAILY_ID = "com.herdr.tauri";

/// Whether this window has the queue, and which one it is.
export type QueueAccess =
  | { kind: "loading" }
  /// Another window owns it, or it could not be read: this one shows it as off.
  | { kind: "none"; reason: string }
  /// Loaded; `separate` when it is a dev build's own queue, not the daily one.
  | { kind: "ready"; separate: boolean };

export interface QueueActions {
  add(folder: string, prompt: string, front: boolean): void;
  edit(folder: string, id: string, prompt: string): void;
  /// Removes a waiting item and returns a function that puts it back.
  remove(folder: string, id: string): () => void;
  /// Runs a waiting item now in a worktree of its own, beside the queue.
  runInWorktree(folder: string, id: string): void;
  /// Takes the item in progress off the queue without pausing it; its tab and
  /// agent are left alone.
  drop(folder: string, id: string): void;
  move(folder: string, id: string, delta: number): void;
  /// Pauses with a reason, or resumes with null.
  pause(folder: string, paused: boolean): void;
  set(folder: string, patch: Partial<Pick<Queue, "commitSuffix" | "requireClean">>): void;
}

/// The queue file, null until it is read. Queues only run while the window is
/// attached to this Mac's daemon, since the CLI that starts agents runs here.
export function useQueue(
  controller: Controller,
  snapshot: Snapshot | null,
  local: boolean,
  folderOf: FolderOf,
  rootOf: FolderOf,
  isOpenSplit: (workspaceId: string) => boolean,
): { file: QueueFile | null; access: QueueAccess; actions: QueueActions } {
  const [file, setFile] = useState<QueueFile | null>(null);
  const [access, setAccess] = useState<QueueAccess>({ kind: "loading" });
  const current = useRef<QueueFile | null>(null);
  const latest = useRef({ snapshot, local, folderOf, rootOf, isOpenSplit });
  latest.current = { snapshot, local, folderOf, rootOf, isOpenSplit };

  /// Inbox files added but not yet deleted, so a slow save never adds one twice.
  const taken = useRef(new Set<string>());
  const draining = useRef(false);

  /// Shows `next` and saves it; the promise settles once it is on disk.
  const commit = useCallback(
    (next: QueueFile) => {
      current.current = next;
      setFile(next);
      const saved = saveQueue(next);
      controller.act(saved);
      return saved;
    },
    [controller],
  );

  /// Applies `change` to the queue on `folder` as it is now, not as it was
  /// when an awaited call began.
  const update = useCallback(
    (folder: string, change: (queue: Queue) => Queue) => {
      const file = current.current;
      if (!file) return;
      const key = queueKey(folder);
      const before = file.queues[key] ?? emptyQueue(folder);
      const after = change(before);
      if (after !== before) commit({ ...file, queues: { ...file.queues, [key]: after } });
    },
    [commit],
  );

  /// Only one window may own the queue (`queue::Owner`), so while another
  /// does, or the load fails, this one tries again every few seconds and
  /// says why only the first time.
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = (first: boolean, id: string) =>
      loadQueue()
        .then((loaded) => {
          if (!live) return;
          setAccess({ kind: "ready", separate: id !== DAILY_ID });
          void commit(recover(loaded, Date.now()));
        })
        .catch((error) => {
          if (!live) return;
          setAccess({ kind: "none", reason: String(error) });
          if (first) controller.act(Promise.reject(error));
          timer = window.setTimeout(() => load(false, id), LOAD_RETRY_MS);
        });
    void getIdentifier()
      .catch(() => DAILY_ID)
      .then((id) => {
        if (!live) return;
        if (DEV_BRANCH && id === DAILY_ID) {
          setAccess({ kind: "none", reason: `The queue runs in the main window; this is a dev build of ${DEV_BRANCH}.` });
          return;
        }
        void load(true, id);
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [commit, controller]);

  /// A run out of line pauses nothing and leaves only a line in the history,
  /// so its failure has to be said out loud.
  const alertAway = useCallback(
    (item: Item, message: string) => controller.alert(`Prompt #${item.n} failed in its worktree`, message),
    [controller],
  );

  const prompt = useCallback(
    async (folder: string, item: Item) => {
      const queue = current.current?.queues[queueKey(folder)] ?? emptyQueue(folder);
      try {
        await promptItem(item, queue);
        update(folder, (q) => patchItem(q, item.id, { state: "running", reason: undefined }));
      } catch (error) {
        const reason = `did not take its prompt: ${error}`;
        update(folder, (q) => end(q, item.id, "failed", Date.now(), reason));
        if (isAway(item)) alertAway(item, `The agent ${reason}`);
      }
    },
    [alertAway, update],
  );

  /// Notes the tab and agent an item got, and prompts it if it is ready.
  const started = useCallback(
    async (folder: string, item: Item, opened: Opened) => {
      const ready = { state: opened.ready ? "prompting" : "waiting", opened: Date.now() } as const;
      update(folder, (q) =>
        patchItem(q, item.id, {
          ...ready,
          tabId: opened.tab_id,
          paneId: opened.pane_id,
          head: opened.head ?? undefined,
          reason: opened.note ?? undefined,
        }),
      );
      if (opened.ready) await prompt(folder, { ...item, ...ready });
    },
    [prompt, update],
  );

  const carryOut = useCallback(
    async (folder: string, effect: Effect) => {
      const { item } = effect;
      const queue = () => current.current?.queues[queueKey(folder)] ?? emptyQueue(folder);
      const directory = queueDirectory(folder);
      switch (effect.kind) {
        case "open": {
          if (queue().requireClean) {
            const changed = (await readCounts([directory]).catch(() => null))?.get(directory) ?? 0;
            if (changed > 0) {
              const files = changed === 1 ? "file" : "files";
              update(folder, (q) => holdBack(q, item.id, `The checkout has ${changed} uncommitted ${files}.`));
              return;
            }
          }
          try {
            await started(folder, item, await openItem(effect.workspaceId, item, directory));
          } catch (error) {
            update(folder, (q) => end(q, item.id, "failed", Date.now(), `could not start: ${error}`));
          }
          return;
        }
        case "prompt":
          return prompt(folder, item);
        case "finished": {
          if (!item.head) return;
          // A worktree already removed has nothing left to count.
          const commits = await countCommits(item.worktree ?? directory, item.head).catch(() => undefined);
          update(folder, (q) => ({
            ...q,
            history: q.history.map((i) => (i.id === item.id ? { ...i, commits } : i)),
          }));
          return;
        }
        case "failed":
          alertAway(item, `The prompt ${item.reason ?? "failed"}.`);
      }
    },
    [alertAway, prompt, started, update],
  );

  const tick = useCallback(() => {
    const { snapshot, local, folderOf, rootOf, isOpenSplit } = latest.current;
    if (!current.current || !snapshot || !local) return;
    const file = foldSplitQueues(current.current, isOpenSplit);
    const now = Date.now();
    const queues = { ...file.queues };
    const effects: [string, Effect][] = [];
    for (const [key, queue] of Object.entries(file.queues)) {
      const result = step(queue, viewOf(queue, snapshot, now, folderOf, rootOf));
      queues[key] = result.queue;
      if (result.effect) effects.push([queue.folder, result.effect]);
    }
    if (file !== current.current || Object.keys(queues).some((key) => queues[key] !== file.queues[key])) commit({ ...file, queues });
    for (const [folder, effect] of effects) void carryOut(folder, effect);
  }, [carryOut, commit]);

  /// Adds the inbox's prompts to their queues and saves, and only then deletes
  /// their files, so a prompt is never lost between the two.
  const drainInbox = useCallback(async () => {
    if (draining.current || !current.current || !latest.current.local) return;
    draining.current = true;
    try {
      const entries = (await readInbox()).filter((entry) => !taken.current.has(entry.name));
      const { snapshot, local, folderOf } = latest.current;
      const file = current.current;
      if (!entries.length || !snapshot || !local) return;
      const result = takeInbox(file, entries, snapshot, Date.now(), folderOf);
      for (const { name, reason } of result.rejected) await settleInbox(name, reason);
      if (!result.added.length) return;
      for (const name of result.added) taken.current.add(name);
      // A failed save is shown by `commit`; the files stay until a later
      // launch, where a duplicate is better than a lost prompt.
      if (!(await commit(result.file).then(() => true, () => false))) return;
      for (const name of result.added) {
        await settleInbox(name, null);
        taken.current.delete(name);
      }
      tick();
    } catch (error) {
      controller.act(Promise.reject(error));
    } finally {
      draining.current = false;
    }
  }, [commit, controller, tick]);

  useEffect(tick, [tick, snapshot, local, file === null]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      tick();
      void drainInbox();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [tick, drainInbox]);

  const actions = useMemo<QueueActions>(
    () => ({
      add(folder, prompt, front) {
        if (!current.current || !prompt.trim()) return;
        commit(addItem(current.current, folder, prompt, front, Date.now()));
        tick();
      },
      edit(folder, id, prompt) {
        if (prompt.trim()) update(folder, (q) => patchItem(q, id, { prompt: prompt.trim() }));
      },
      remove(folder, id) {
        let undo = () => {};
        update(folder, (q) => {
          const item = q.items.find((i) => i.id === id);
          const { queue, index } = removeItem(q, id);
          if (item && index >= 0) undo = () => update(folder, (q) => restoreItem(q, item, index));
          return queue;
        });
        return undo;
      },
      runInWorktree(folder, id) {
        const queue = current.current?.queues[queueKey(folder)];
        const item = queue?.items.find((i) => i.id === id && i.state === "queued");
        if (!item) return;
        const directory = queueDirectory(folder);
        const path = worktreePath(directory, item);
        update(folder, (q) => sendAway(q, id, Date.now(), path));
        openWorktree(item, directory, path)
          .then((opened) => started(folder, { ...item, state: "starting", worktree: path }, opened))
          .catch((error) => {
            update(folder, (q) => bringBack(q, id));
            controller.alert(`Could not run prompt #${item.n} in a worktree`, `${error}\n\nThe prompt is back in the queue.`);
          });
      },
      drop(folder, id) {
        update(folder, (q) => dropItem(q, id, Date.now()));
        tick();
      },
      move(folder, id, delta) {
        update(folder, (q) => moveItem(q, id, delta));
      },
      pause(folder, paused) {
        update(folder, (q) => ({ ...q, paused: paused ? { reason: "Paused by you." } : null }));
        if (!paused) tick();
      },
      set(folder, patch) {
        update(folder, (q) => ({ ...q, ...patch }));
      },
    }),
    [commit, controller, started, tick, update],
  );

  return { file, access, actions };
}
