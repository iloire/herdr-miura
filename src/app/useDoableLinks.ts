// Reads which Doable tasks prompts came from (`doableLinks.ts`) as often as
// the ledger is read. Completing a task or adding a subtask waits for a click
// (`write`); where the task stands (its agent state) is written by itself.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Outcome } from "./ledger";
import {
  EMPTY_LINKS,
  type Linked,
  type LinksFile,
  linkedOutcomes,
  readLinks,
  report,
  toReport,
  type TaskLink,
  writeBack,
} from "./doableLinks";

const POLL_MS = 10_000;

export interface DoableLinks {
  /// Every prompt sent from a task, by the pane it went to.
  links: readonly TaskLink[];
  /// Ledger entries by id, with the task they came from.
  linked: ReadonlyMap<string, Linked>;
  /// Writes `outcome` back to its task; settles once it is recorded.
  write: (outcome: Outcome) => Promise<void>;
}

export function useDoableLinks(list: Outcome[]): DoableLinks {
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

  // One at a time, each once: the links file records it, and `reporting` covers the wait.
  const reporting = useRef(new Set<string>());
  useEffect(() => {
    const due = toReport(list, linked).filter((o) => !reporting.current.has(o.id));
    if (due.length === 0) return;
    for (const o of due) reporting.current.add(o.id);
    due
      .reduce((done, o) => done.then(() => report(linked.get(o.id)!, o).then(() => {}, () => {})), Promise.resolve())
      .finally(refresh);
  }, [list, linked, refresh]);

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

  return useMemo(() => ({ links: file.links, linked, write }), [file.links, linked, write]);
}
