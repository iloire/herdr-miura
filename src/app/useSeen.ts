// Keeps the Mark as Seen record and gives the window the snapshot it applies to.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, Snapshot } from "../protocol";
import { seenSnapshot } from "./attention";
import { loadSeen, markSeen, pruneSeen, saveSeen, seenPanes } from "./seen";

export function useSeen(
  snapshot: Snapshot | null,
  host: string | null,
): {
  /// The snapshot with marked agents read as seen, for whatever shows attention.
  shown: Snapshot | null;
  /// Marks finished agents of the snapshot on show.
  markSeen: (agents: Agent[]) => void;
} {
  const [records, setRecords] = useState(loadSeen);

  useEffect(() => {
    if (!snapshot) return;
    const next = pruneSeen(records, host, snapshot);
    if (next === records) return;
    setRecords(next);
    saveSeen(next);
  }, [snapshot, host, records]);

  const shown = useMemo(
    () => snapshot && seenSnapshot(snapshot, seenPanes(records, host, snapshot.boot_id)),
    [snapshot, host, records],
  );
  const bootId = snapshot?.boot_id;
  const mark = useCallback(
    (agents: Agent[]) => {
      if (bootId === undefined) return;
      setRecords((current) => {
        const next = markSeen(current, host, bootId, agents);
        saveSeen(next);
        return next;
      });
    },
    [bootId, host],
  );
  return { shown, markSeen: mark };
}
