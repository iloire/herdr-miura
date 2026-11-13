// Notes when agents go idle, for the Agents tab's Recent section.

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../protocol";
import { busyPanes, type IdleSince, loadRecent, saveRecent, stampIdle } from "./agentsView";

/// When each agent of `snapshot` (a `seenSnapshot`, so marking seen counts as
/// going idle) last went idle, as far as this window has watched.
export function useRecent(snapshot: Snapshot | null): IdleSince {
  const [records, setRecords] = useState(loadRecent);
  const busy = useRef<Set<string> | null>(null);
  const bootId = snapshot?.boot_id;

  useEffect(() => {
    if (!snapshot) return;
    // A first snapshot has nothing before it to have gone idle from.
    const previous = busy.current ?? busyPanes(snapshot.agents);
    busy.current = busyPanes(snapshot.agents);
    setRecords((current) => {
      const next = stampIdle(current, snapshot.boot_id, previous, snapshot.agents, Date.now());
      if (next !== current) saveRecent(next);
      return next;
    });
  }, [snapshot]);

  return (bootId && records[bootId]) || {};
}
