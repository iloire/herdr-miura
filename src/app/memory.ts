import { invoke } from "@tauri-apps/api/core";
import type { Pane, Tab } from "../protocol";

/// One process of a pane, as `process_memory` reports it.
export interface PaneProcess {
  pid: number;
  name: string;
  command: string;
  /// Physical footprint on macOS (Activity Monitor's Memory), resident size elsewhere.
  bytes: number;
}

/// Each pane's processes, largest first; a pane with none is absent.
export type PaneMemory = Map<string, PaneProcess[]>;

export async function readMemory(): Promise<PaneMemory> {
  const panes = await invoke<Record<string, PaneProcess[]>>("process_memory");
  return new Map(Object.entries(panes));
}

const MB = 1024 * 1024;

/// Same processes, each within a megabyte: nothing worth a redraw.
export function sameMemory(a: PaneMemory, b: PaneMemory): boolean {
  if (a.size !== b.size) return false;
  for (const [pane, list] of a) {
    const other = b.get(pane);
    if (!other || other.length !== list.length) return false;
    const differs = (process: PaneProcess, i: number) =>
      process.pid !== other[i].pid || Math.round(process.bytes / MB) !== Math.round(other[i].bytes / MB);
    if (list.some(differs)) return false;
  }
  return true;
}

/// What the memory dialog lists: one tab's processes, or a whole workspace's.
export type MemoryScope = { kind: "tab" | "workspace"; id: string };

/// A process with the tab it runs in.
export interface ScopedProcess extends PaneProcess {
  tab: string;
}

/// The processes of the panes in `scope`, largest first.
export function scopeProcesses(memory: PaneMemory, panes: Pane[], tabs: Tab[], scope: MemoryScope): ScopedProcess[] {
  const label = new Map(tabs.map((tab) => [tab.tab_id, tab.label]));
  return panes
    .filter((pane) => (scope.kind === "tab" ? pane.tab_id : pane.workspace_id) === scope.id)
    .flatMap((pane) => (memory.get(pane.pane_id) ?? []).map((process) => ({ ...process, tab: label.get(pane.tab_id) ?? "" })))
    .sort((a, b) => b.bytes - a.bytes || a.pid - b.pid);
}

export function totalBytes(processes: readonly PaneProcess[]): number {
  return processes.reduce((sum, process) => sum + process.bytes, 0);
}

/// `812 MB`, `1.4 GB`, as Activity Monitor writes them.
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
