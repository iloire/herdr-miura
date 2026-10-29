import { isPending, type Worktree, worktreeTitle } from "../changes/worktrees";

/// `⑂3`: how many linked worktrees a checkout has, colored while any holds
/// work not yet merged; hovering lists each with what is pending in it.
export function Worktrees({ worktrees }: { worktrees: Worktree[] }) {
  if (worktrees.length === 0) return null;
  const pending = worktrees.some(isPending);
  const title = worktreeTitle(worktrees);
  return (
    <span className={`git-worktrees ${pending ? "pending" : ""}`} title={title} aria-label={title}>
      ⑂{worktrees.length}
    </span>
  );
}
