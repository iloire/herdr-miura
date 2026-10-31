// The highlighter's thread. A grammar's first use compiles its regexes, 1.4 s
// for TypeScript in WKWebView, so none of `highlight` runs on the UI thread.

import { highlight } from "./highlight";
import type { HighlightReply, HighlightRequest } from "./offThread";

const running = new Map<number, AbortController>();

addEventListener("message", async ({ data }: MessageEvent<HighlightRequest>) => {
  if ("cancel" in data) {
    running.get(data.cancel)?.abort();
    return;
  }
  const stale = new AbortController();
  running.set(data.id, stale);
  const tokens = await highlight(data.code, data.path, stale.signal);
  running.delete(data.id);
  postMessage({ id: data.id, tokens } satisfies HighlightReply);
});
