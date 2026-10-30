// What a workspace card's Git line shows.

/// The branch to name on the card. `main` and `master` say nothing, so they
/// are left out; any other name warns the checkout is off the default branch.
export function shownBranch(branch: string | null): string | null {
  return branch === "main" || branch === "master" ? null : branch;
}

/// Whether the line has anything on it: a branch to name, or a count above zero.
export function hasGitLine(branch: string | null, counts: number[]): boolean {
  return Boolean(shownBranch(branch)) || counts.some((count) => count > 0);
}
