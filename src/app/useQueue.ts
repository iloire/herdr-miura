// The window's side of the prompt queue: loads the file, runs `step` for
// every queue on each snapshot and once a second (for the finish debounce),
// carries out what it asks for, and saves after every change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readCounts } from "../changes/counts";
import type { Snapshot } from "../protocol";
import type { Controller } from "./controller";
import {
  addItem,
  countCommits,
  type Effect,
  emptyQueue,
  end,
  holdBack,
  type Item,
  loadQueue,
  moveItem,
  openItem,
  patchItem,
  promptItem,
  type Queue,
  type QueueFile,
  queueKey,
  recover,
  removeItem,
  restoreItem,
  saveQueue,
  step,
  viewOf,
} from "./queue";

const TICK_MS = 1000;

export interface QueueActions {
  add(folder: string, prompt: string, front: boolean): void;
  edit(folder: string, id: string, prompt: string): void;
  /// Removes a waiting item and returns a function that puts it back.
  remove(folder: string, id: string): () => void;
  move(folder: string, id: string, delta: number): void;
  /// Pauses with a reason, or resumes with null.
  pause(folder: string, paused: boolean): void;
  set(folder: string, patch: Partial<Pick<Queue, "stopAfter" | "commitSuffix" | "requireClean">>): void;
}

/// The queue file, null until it is read. Queues only run while the window is
/// attached to this Mac's daemon, since the CLI that starts agents runs here.
export function useQueue(
  controller: Controller,
  snapshot: Snapshot | null,
  local: boolean,
): { file: QueueFile | null; actions: QueueActions } {
  const [file, setFile] = useState<QueueFile | null>(null);
  const current = useRef<QueueFile | null>(null);
  const latest = useRef({ snapshot, local });
  latest.current = { snapshot, local };

  const commit = useCallback(
    (next: QueueFile) => {
      current.current = next;
      setFile(next);
      controller.act(saveQueue(next));
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

  useEffect(() => {
    let live = true;
    loadQueue()
      .then((loaded) => live && commit(recover(loaded, Date.now())))
      .catch((error) => controller.act(Promise.reject(error)));
    return () => {
      live = false;
    };
  }, [commit, controller]);

  const carryOut = useCallback(
    async (folder: string, effect: Effect) => {
      const { item } = effect;
      const queue = () => current.current?.queues[queueKey(folder)] ?? emptyQueue(folder);
      const prompt = async (item: Item) => {
        try {
          await promptItem(item, queue());
          update(folder, (q) => patchItem(q, item.id, { state: "running", reason: undefined }));
        } catch (error) {
          update(folder, (q) => end(q, item.id, "failed", Date.now(), `did not take its prompt: ${error}`));
        }
      };
      switch (effect.kind) {
        case "open": {
          if (queue().requireClean) {
            const changed = (await readCounts([folder]).catch(() => null))?.get(folder) ?? 0;
            if (changed > 0) {
              const files = changed === 1 ? "file" : "files";
              update(folder, (q) => holdBack(q, item.id, `The checkout has ${changed} uncommitted ${files}.`));
              return;
            }
          }
          try {
            const opened = await openItem(effect.workspaceId, item, folder);
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
            if (opened.ready) await prompt({ ...item, ...ready });
          } catch (error) {
            update(folder, (q) => end(q, item.id, "failed", Date.now(), `could not start: ${error}`));
          }
          return;
        }
        case "prompt":
          return prompt(item);
        case "finished": {
          if (!item.head) return;
          const commits = await countCommits(folder, item.head).catch(() => undefined);
          update(folder, (q) => ({
            ...q,
            history: q.history.map((i) => (i.id === item.id ? { ...i, commits } : i)),
          }));
        }
      }
    },
    [update],
  );

  const tick = useCallback(() => {
    const file = current.current;
    const { snapshot, local } = latest.current;
    if (!file || !snapshot || !local) return;
    const now = Date.now();
    const queues = { ...file.queues };
    const effects: [string, Effect][] = [];
    for (const [key, queue] of Object.entries(file.queues)) {
      const result = step(queue, viewOf(queue, snapshot, now));
      queues[key] = result.queue;
      if (result.effect) effects.push([queue.folder, result.effect]);
    }
    if (Object.keys(queues).some((key) => queues[key] !== file.queues[key])) commit({ ...file, queues });
    for (const [folder, effect] of effects) void carryOut(folder, effect);
  }, [carryOut, commit]);

  useEffect(tick, [tick, snapshot, local, file === null]);
  useEffect(() => {
    const timer = window.setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [tick]);

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
    [commit, tick, update],
  );

  return { file, actions };
}
