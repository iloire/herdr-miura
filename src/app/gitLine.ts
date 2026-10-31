// What a workspace card's Git line and the tab header's checkout show.

import type { ChangesState, CheckoutChanges } from "../changes/store";

/// The branch to name on the card. `main` and `master` say nothing, so they
/// are left out; any other name warns the checkout is off the default branch.
export function shownBranch(branch: string | null): string | null {
  return branch === "main" || branch === "master" ? null : branch;
}

/// Whether the line has anything on it: a branch to name, or a count above zero.
export function hasGitLine(branch: string | null, counts: number[]): boolean {
  return Boolean(shownBranch(branch)) || counts.some((count) => count > 0);
}

/// What the tab header says about a checkout: every field can be empty.
export interface TabGit {
  branch: string | null;
  changed: number;
  ahead: number;
  behind: number;
  unmerged: { count: number; base: string } | null;
  /// What is under way, as `rebasing 3/7`.
  operation: string | null;
  /// Files with unresolved conflicts.
  conflicts: number;
}

const OPERATIONS = { rebase: "rebasing", merge: "merging", "cherry-pick": "cherry-picking" };

/// `rebasing 3/7`, `merging`, or null with nothing under way.
export function operationLabel({ operation, operation_step: step }: Pick<CheckoutChanges, "operation" | "operation_step">): string | null {
  if (!operation) return null;
  return step ? `${OPERATIONS[operation]} ${step[0]}/${step[1]}` : OPERATIONS[operation];
}

/// The tab header's Git facts for the focused directory. The store keeps the
/// previous directory's result while a read runs, so a result for any other
/// directory counts as nothing rather than as this tab's. Null with nothing
/// to say, as on a clean main with everything pushed. A rebase detaches HEAD,
/// so it alone can be all there is to say.
export function tabGit(state: ChangesState, directory: string | null): TabGit | null {
  if (state.phase !== "ready" || state.directory !== directory || !state.checkout) return null;
  const { branch, total_files: changed, ahead, behind, unmerged, conflicts } = state.checkout;
  const [base, count] = unmerged ?? ["", 0];
  const operation = operationLabel(state.checkout);
  if (!operation && !hasGitLine(branch, [changed, ahead, behind, count, conflicts])) return null;
  return { branch: shownBranch(branch), changed, ahead, behind, unmerged: count > 0 ? { count, base } : null, operation, conflicts };
}
