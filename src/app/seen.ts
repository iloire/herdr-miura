// What the user marked seen from a workspace card. Seen is per pane in the
// daemon and only focusing a pane sets it, so the window keeps its own record of
// the `state_change_seq` each agent was at; `seenSnapshot` in `attention.ts`
// applies it. Sequences mean nothing across a daemon's boots, and hosts have a
// daemon each, so every host keeps its own record, tied to its boot.

import type { Agent, Snapshot } from "../protocol";
import type { SeenPanes } from "./attention";
import { unseenDone } from "./attention";

const KEY = "seen-agents";

interface HostRecord {
  bootId: string;
  panes: SeenPanes;
}

/// By host name, with `LOCAL` for this machine's daemon.
export type SeenRecords = Readonly<Record<string, HostRecord>>;

const LOCAL = "";
const NOTHING_SEEN: SeenPanes = {};

export function loadSeen(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): SeenRecords {
  try {
    return (JSON.parse(storage?.getItem(KEY) ?? "null") as SeenRecords | null) ?? {};
  } catch {
    return {};
  }
}

export function saveSeen(records: SeenRecords, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(records));
  } catch {
    // Marks that are not remembered only come back at the next launch.
  }
}

/// The panes marked seen on `host`'s daemon as it now runs.
export function seenPanes(records: SeenRecords, host: string | null, bootId: string): SeenPanes {
  const record = records[host ?? LOCAL];
  return record?.bootId === bootId ? record.panes : NOTHING_SEEN;
}

/// `records` with `agents` of boot `bootId` marked seen at the sequence they
/// show: only finished ones, so a blocked agent can never be dismissed.
export function markSeen(records: SeenRecords, host: string | null, bootId: string, agents: readonly Agent[]): SeenRecords {
  const panes = { ...seenPanes(records, host, bootId) };
  for (const agent of unseenDone(agents)) panes[agent.pane_id] = agent.state_change_seq;
  return { ...records, [host ?? LOCAL]: { bootId, panes } };
}

/// `records` without what this snapshot makes pointless: a past boot's record
/// and the panes that are gone. The same object comes back when nothing goes.
/// A tab being closed has no panes in the window's snapshot but keeps its
/// agents, and if the close fails its marks should still be there.
export function pruneSeen(records: SeenRecords, host: string | null, snapshot: Snapshot): SeenRecords {
  const key = host ?? LOCAL;
  const record = records[key];
  if (!record) return records;
  const live = new Set([...snapshot.panes, ...snapshot.agents].map(({ pane_id }) => pane_id));
  const kept = Object.entries(seenPanes(records, host, snapshot.boot_id)).filter(([pane]) => live.has(pane));
  if (record.bootId === snapshot.boot_id && kept.length === Object.keys(record.panes).length) return records;
  const { [key]: _gone, ...rest } = records;
  return kept.length > 0 ? { ...rest, [key]: { bootId: snapshot.boot_id, panes: Object.fromEntries(kept) } } : rest;
}
