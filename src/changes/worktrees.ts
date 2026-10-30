import { invoke } from "@tauri-apps/api/core";

/// A linked worktree of a workspace's checkout, as `worktrees` reports it.
export interface Worktree {
  path: string;
  /// `null` when its HEAD is detached.
  branch: string | null;
  /// Its last commit's subject and Unix time; `null` when unread.
  subject: string | null;
  time: number | null;
  /// The remote's default branch `unmerged` counts against, as `origin/main`.
  base: string | null;
  /// Commits the remote's default branch lacks; `null` when unknown.
  unmerged: number | null;
  /// Files changed in it; `null` when unread.
  changed: number | null;
  /// The main checkout's folder: what every worktree of a repo shares.
  repo: string;
  /// The local branch work lands on, as `main`; `null` when there is none.
  main: string | null;
  /// Commits `main` lacks; `null` when unknown.
  ahead: number | null;
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

/// Worktrees holding work first: they are the ones to land or drop.
export function pendingFirst(worktrees: readonly Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => Number(isPending(b)) - Number(isPending(a)));
}

/// Its branch, or its folder's name when detached.
export function worktreeName(worktree: Worktree): string {
  return worktree.branch ?? `${worktree.path.split("/").pop()} (detached)`;
}

/// What is still pending in it, or that nothing is.
function worktreeState(worktree: Worktree): string[] {
  const state = [];
  if (worktree.unmerged) state.push(`${worktree.unmerged} unmerged`);
  if (worktree.changed) state.push(`${worktree.changed} changed`);
  if (state.length === 0) state.push(worktree.unmerged === 0 ? "merged, clean" : "clean");
  return state;
}

/// The `⑂3` mark's tooltip: how many, how many pending, then each.
export function worktreeTitle(worktrees: Worktree[]): string {
  const pending = worktrees.filter(isPending).length;
  const count = `${worktrees.length} ${worktrees.length === 1 ? "worktree" : "worktrees"}`;
  const head = pending > 0 ? `${count}, ${pending} not merged` : `${count}, all merged`;
  const lines = worktrees.map((worktree) => `${worktreeName(worktree)}: ${worktreeState(worktree).join(", ")}`);
  return [head, ...lines].join("\n");
}
