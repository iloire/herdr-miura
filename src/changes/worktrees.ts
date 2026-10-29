import { invoke } from "@tauri-apps/api/core";

/// A linked worktree of a workspace's checkout, as `worktrees` reports it.
export interface Worktree {
  path: string;
  /// `null` when its HEAD is detached.
  branch: string | null;
  /// Commits the remote's default branch lacks; `null` when unknown.
  unmerged: number | null;
  /// Files changed in it; `null` when unread.
  changed: number | null;
}

/// Each directory's linked worktrees, the main checkout left out; `null` outside Git.
export async function readWorktrees(directories: string[]): Promise<Map<string, Worktree[] | null>> {
  const lists = await invoke<(Worktree[] | null)[]>("worktrees", { directories });
  return new Map(directories.map((directory, i) => [directory, lists[i] ?? null]));
}

/// Work not yet on the default branch, or not yet committed.
export function isPending(worktree: Worktree): boolean {
  return (worktree.unmerged ?? 0) > 0 || (worktree.changed ?? 0) > 0;
}

/// One line per worktree for a tooltip: its branch, or its folder's name
/// when detached, then what is still pending in it.
export function worktreeLines(worktrees: Worktree[]): string[] {
  return worktrees.map((worktree) => {
    const name = worktree.branch ?? `${worktree.path.split("/").pop()} (detached)`;
    const state = [];
    if (worktree.unmerged) state.push(`${worktree.unmerged} unmerged`);
    if (worktree.changed) state.push(`${worktree.changed} changed`);
    if (state.length === 0) state.push(worktree.unmerged === 0 ? "merged, clean" : "clean");
    return `${name}: ${state.join(", ")}`;
  });
}

/// The `⑂3` mark's tooltip: how many, how many pending, then each.
export function worktreeTitle(worktrees: Worktree[]): string {
  const pending = worktrees.filter(isPending).length;
  const count = `${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}`;
  const head = pending > 0 ? `${count}, ${pending} not merged` : `${count}, all merged`;
  return [head, ...worktreeLines(worktrees)].join("\n");
}
