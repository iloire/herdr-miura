// The commit row's writes: check a commit out detached, start a branch at it,
// revert it. `commit_ops.rs` does the work and checks everything again.

import { invoke } from "@tauri-apps/api/core";
import type { CheckoutChanges } from "./store";
import type { SyncOutcome } from "./sync";

/// Why the checkout cannot move to another commit, short enough for a menu
/// row, or null when it can. Every agent in the checkout works on its tree,
/// so only a clean one with nothing under way moves; nothing is stashed.
export function commitBlock(checkout: CheckoutChanges): string | null {
  if (checkout.operation) return `${checkout.operation} under way`;
  if (checkout.total_files > 0) {
    return `${checkout.total_files} uncommitted ${checkout.total_files === 1 ? "change" : "changes"}`;
  }
  return null;
}

/// As `commitBlock`, and a revert also needs a branch to land on.
export function revertBlock(checkout: CheckoutChanges): string | null {
  return commitBlock(checkout) ?? (checkout.branch ? null : "HEAD is detached");
}

export function checkoutCommit(checkout: string, sha: string): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("checkout_commit", { checkout, sha });
}

export function branchFromCommit(checkout: string, sha: string, name: string): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("branch_from_commit", { checkout, sha, name });
}

export function revertCommit(checkout: string, sha: string, branch: string | null): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("revert_commit", { checkout, sha, branch });
}
