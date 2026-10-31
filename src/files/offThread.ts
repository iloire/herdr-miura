// `highlight` (files/highlight.ts) from the UI thread, through one worker that
// keeps its compiled grammars between files.

import type { Token } from "./highlight";

export type HighlightRequest = { id: number; code: string; path: string } | { cancel: number };
export interface HighlightReply {
  id: number;
  tokens: Token[][] | null;
}

const waiting = new Map<number, (tokens: Token[][] | null) => void>();
let worker: Worker | null = null;
let nextId = 0;

function start(): Worker {
  const started = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  started.addEventListener("message", ({ data }: MessageEvent<HighlightReply>) => {
    waiting.get(data.id)?.(data.tokens);
    waiting.delete(data.id);
  });
  // A worker that cannot start or has died leaves everything plain, and the next file tries a new one.
  started.addEventListener("error", () => {
    for (const settle of waiting.values()) settle(null);
    waiting.clear();
    worker = null;
  });
  return started;
}

/// As `highlight`, whose `null` it keeps, off the UI thread. An abort settles
/// at once, and stops the work behind it.
export function highlightOffThread(code: string, path: string, signal: AbortSignal): Promise<Token[][] | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    worker ??= start();
    waiting.set(id, resolve);
    worker.postMessage({ id, code, path } satisfies HighlightRequest);
    signal.addEventListener("abort", () => {
      if (!waiting.delete(id)) return;
      resolve(null);
      worker?.postMessage({ cancel: id } satisfies HighlightRequest);
    });
  });
}
