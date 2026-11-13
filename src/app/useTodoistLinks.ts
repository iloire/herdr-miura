// Reads which Todoist tasks prompts came from (`todoistLinks.ts`) as often as
// the ledger is read, and comments on a task by itself when its agent waits on
// you. Completing a task or adding a subtask waits for a click (`write`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Controller } from "./controller";
import type { Outcome } from "./ledger";
import { EMPTY_LINKS, type Linked, type LinksFile, linkedOutcomes, readLinks, toComment, writeBack } from "./todoistLinks";

const POLL_MS = 10_000;

export interface TodoistLinks {
  /// Ledger entries by id, with the task they came from.
  linked: ReadonlyMap<string, Linked>;
  /// Writes `outcome` back to its task; settles once it is recorded.
  write: (outcome: Outcome) => Promise<void>;
}

export function useTodoistLinks(controller: Controller, list: Outcome[], local: boolean): TodoistLinks {
  const [file, setFile] = useState<LinksFile>(EMPTY_LINKS);
  const refresh = useCallback(() => {
    readLinks()
      .then(setFile)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const linked = useMemo(() => linkedOutcomes(list, file), [list, file]);

  const write = useCallback(
    async (outcome: Outcome) => {
      const link = linked.get(outcome.id);
      if (!link) return;
      try {
        await writeBack(link, outcome);
      } finally {
        refresh();
      }
    },
    [linked, refresh],
  );

  // Each ask is tried once a launch: a failure is shown, not retried every poll.
  // `todoist.rs` writes it once however many windows try.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!local) return;
    for (const outcome of toComment(list, linked)) {
      if (tried.current.has(outcome.id)) continue;
      tried.current.add(outcome.id);
      controller.act(write(outcome));
    }
  }, [controller, local, list, linked, write]);

  return useMemo(() => ({ linked, write }), [linked, write]);
}
