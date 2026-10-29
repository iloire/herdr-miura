import { isPending, type Worktree, worktreeTitle } from "../changes/worktrees";

/// `⑂3`: how many linked worktrees a checkout has, colored while any holds
/// work not yet merged; hovering lists each, clicking opens the details.
/// A span, not a button: on a workspace card it sits inside the card's button.
export function Worktrees({ worktrees, onOpen }: { worktrees: Worktree[]; onOpen: () => void }) {
  if (worktrees.length === 0) return null;
  const pending = worktrees.some(isPending);
  const title = `${worktreeTitle(worktrees)}\nClick for details`;
  return (
    <span
      className={`git-worktrees ${pending ? "pending" : ""}`}
      role="button"
      title={title}
      aria-label={title}
      onClick={(event) => {
        // The card's own click would focus the workspace instead.
        event.stopPropagation();
        onOpen();
      }}
    >
      ⑂{worktrees.length}
    </span>
  );
}
