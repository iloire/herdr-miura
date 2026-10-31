// What a row in the Changes panel offers, and committing the rows ticked.

import { invoke } from "@tauri-apps/api/core";
import type { ChangedFile, CheckoutChanges } from "./store";
import type { SyncOutcome } from "./sync";

/// The file on disk, as a person would paste it. `path` is relative to the checkout.
export function absolutePath(checkout: string, path: string): string {
  return `${checkout.replace(/\/+$/, "")}/${path}`;
}

/// Only a file that is there can be opened: a deleted one is not, and Git
/// lists an untracked folder as `dir/`.
export function canOpen(file: ChangedFile): boolean {
  return file.mark !== "D" && !file.path.endsWith("/");
}

/// Ticks can only make a commit on a branch with a commit, and with no merge or
/// rebase under way. The backend checks again.
export function canCommit(checkout: CheckoutChanges): boolean {
  return checkout.branch !== null && checkout.born && checkout.operation === null;
}

/// A conflict has to be resolved before it can be committed.
export function canTick(file: ChangedFile): boolean {
  return file.mark !== "U";
}

/// `ticks` without the files that left the list, so one that comes back is
/// unticked. The same set when nothing left, so a caller can tell.
export function keepListed(ticks: ReadonlySet<string>, files: ChangedFile[]): ReadonlySet<string> {
  const kept = new Set(files.map((file) => file.path).filter((path) => ticks.has(path)));
  return kept.size === ticks.size ? ticks : kept;
}

/// How much of the list is ticked, for its header box. A conflict does not count against "all".
export function tickState(ticks: ReadonlySet<string>, files: ChangedFile[]): "none" | "some" | "all" {
  const tickable = files.filter(canTick);
  const count = tickable.filter((file) => ticks.has(file.path)).length;
  if (count === 0) return "none";
  return count === tickable.length ? "all" : "some";
}

/// The header box's click: everything that can be ticked, or nothing once that is what's ticked.
export function toggleAll(ticks: ReadonlySet<string>, files: ChangedFile[]): ReadonlySet<string> {
  if (tickState(ticks, files) === "all") return new Set();
  return new Set(files.filter(canTick).map((file) => file.path));
}

/// Commits these paths as they are on disk, and nothing an agent has staged.
export function commitPaths(
  checkout: string,
  paths: string[],
  message: string,
  branch: string | null,
): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("commit_paths", { checkout, paths, message, branch });
}
