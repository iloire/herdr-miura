// The branch list: the checkout's local branches, switching between them on a
// clean tree, and deleting the ones merged into the default branch.

import { invoke } from "@tauri-apps/api/core";
import type { CheckoutChanges } from "./store";
import type { SyncOutcome } from "./sync";

export interface Branch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /// Its upstream is gone from the remote.
  gone: boolean;
  /// Its newest commit, in seconds since the Unix epoch.
  time: number;
  /// HEAD is on it here.
  current: boolean;
  /// The checkout it is checked out in, this one included.
  worktree: string | null;
}

export interface Branches {
  branches: Branch[];
  total: number;
  /// What `merged` was measured against.
  base: string | null;
  /// Merged into `base`, checked out nowhere: what a delete may offer.
  merged: string[];
}

export function readBranches(directory: string): Promise<Branches> {
  return invoke<Branches>("branches", { directory });
}

export function switchBranch(checkout: string, to: string, branch: string | null): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("switch_branch", { checkout, to, branch });
}

export function deleteBranch(checkout: string, name: string): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("delete_branch", { checkout, name });
}

/// Why the checkout cannot switch to `branch`, short enough for the row, or
/// null when it can. Every agent in the checkout works on its tree, so only a
/// clean one with nothing under way moves. The backend checks again.
export function switchBlock(checkout: CheckoutChanges, branch: Branch): string | null {
  if (branch.current) return "current";
  if (checkout.operation) return `${checkout.operation} under way`;
  if (!checkout.branch) return "HEAD is detached";
  if (checkout.total_files > 0) {
    return `${checkout.total_files} uncommitted ${checkout.total_files === 1 ? "change" : "changes"}`;
  }
  if (branch.worktree && branch.worktree !== checkout.path) {
    return `in worktree ${branch.worktree.split("/").pop()}`;
  }
  return null;
}

/// `↑2 ↓1`, `gone`, or nothing when level with its upstream or without one.
export function tracking(branch: Branch): string {
  if (branch.gone) return "gone";
  return [branch.ahead > 0 && `↑${branch.ahead}`, branch.behind > 0 && `↓${branch.behind}`].filter(Boolean).join(" ");
}
