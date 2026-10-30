import { invoke } from "@tauri-apps/api/core";
import type { Pane } from "../protocol";

/// A TCP port a workspace's process listens on, as `listening_ports` reports it.
export interface ListeningPort {
  port: number;
  /// `*:3000`, `localhost:3000`, or a specific address.
  address: string;
  process: string;
  url: string;
  /// The pane that started it; null for a pane from an older Herdr.
  pane: string | null;
}

/// Each workspace's listening ports, lowest first; a workspace with none is absent.
export async function readPorts(): Promise<Map<string, ListeningPort[]>> {
  const ports = await invoke<Record<string, ListeningPort[]>>("listening_ports");
  return new Map(Object.entries(ports));
}

/// Same ports, same order: nothing to redraw.
export function samePorts(a: Map<string, ListeningPort[]>, b: Map<string, ListeningPort[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [workspace, ports] of a) {
    const other = b.get(workspace);
    if (!other || other.length !== ports.length) return false;
    const differs = (port: ListeningPort, i: number) =>
      port.url !== other[i].url || port.process !== other[i].process || port.pane !== other[i].pane;
    if (ports.some(differs)) return false;
  }
  return true;
}

/// Those of `ports` that a pane of `tab` started. A pane knows its tab only from
/// the snapshot: the listener's own `HERDR_TAB_ID` goes stale when a pane moves.
/// A listener whose pane is unknown belongs to no tab.
export function tabPorts(ports: ListeningPort[], panes: Pane[], tab: string): ListeningPort[] {
  const here = new Set(panes.filter((pane) => pane.tab_id === tab).map((pane) => pane.pane_id));
  return ports.filter((port) => port.pane !== null && here.has(port.pane));
}

/// How many ports an expanded workspace card lists before it says how many more.
const PORT_ROWS = 3;

/// The ports a card lists until it is asked for all of them, keeping their
/// order, and how many that leaves out.
export function portRows(ports: readonly ListeningPort[]): { rows: ListeningPort[]; more: number } {
  return { rows: ports.slice(0, PORT_ROWS), more: Math.max(0, ports.length - PORT_ROWS) };
}
