// Throwing one file's change away. `worktree_ops.rs` does the work and refuses
// what it finds on disk: the plan says what would happen, and the discard
// refuses a file that moved since the plan was read.

import { invoke } from "@tauri-apps/api/core";
import type { ChangedFile } from "./store";
import type { SyncOutcome } from "./sync";

export type DiscardEffect = "revert" | "remove" | "rename_back" | "bring_back" | "trash";

export interface DiscardPlan {
  effect: DiscardEffect;
  old_path: string | null;
  additions: number | null;
  deletions: number | null;
  /// The index holds a version of its own, which is not kept.
  drops_staged: boolean;
  /// A copy of the working file goes to the Trash.
  keeps_copy: boolean;
  /// Passed back to the discard, which refuses if the file no longer matches.
  fingerprint: string;
}

type PlanAnswer = ({ kind: "ready" } & DiscardPlan) | { kind: "refused"; message: string };

export function discardPlan(checkout: string, path: string, branch: string | null): Promise<PlanAnswer> {
  return invoke<PlanAnswer>("discard_plan", { checkout, path, branch });
}

export function discardFile(
  checkout: string,
  path: string,
  fingerprint: string,
  branch: string | null,
): Promise<SyncOutcome> {
  return invoke<SyncOutcome>("discard_file", { checkout, path, fingerprint, branch });
}

/// What the dialog says will happen to the file, `old_path` being its old name.
export function discardSummary(plan: DiscardPlan): string {
  switch (plan.effect) {
    case "revert":
      return "It goes back to the last commit.";
    case "remove":
      return "This file is new, so it is removed.";
    case "rename_back":
      return `It goes back to its old name, ${plan.old_path}, and the last commit's content.`;
    case "bring_back":
      return "It comes back from the last commit.";
    case "trash":
      return "This file is untracked, so it moves to the Trash.";
  }
}

/// Whether the dialog should promise a copy: an untracked file is itself what moves.
export function promisesCopy(plan: DiscardPlan): boolean {
  return plan.keeps_copy && plan.effect !== "trash";
}

/// The file the diff view moves to once `path` is gone: the next one, or none
/// after the last.
export function fileAfter(files: ChangedFile[], path: string): ChangedFile | null {
  const index = files.findIndex((file) => file.path === path);
  return index >= 0 ? (files[index + 1] ?? null) : null;
}
