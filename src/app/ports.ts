import { invoke } from "@tauri-apps/api/core";

/// A TCP port a workspace's process listens on, as `listening_ports` reports it.
export interface ListeningPort {
  port: number;
  /// `*:3000`, `localhost:3000`, or a specific address.
  address: string;
  process: string;
  url: string;
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
    if (ports.some((port, i) => port.url !== other[i].url || port.process !== other[i].process)) return false;
  }
  return true;
}
