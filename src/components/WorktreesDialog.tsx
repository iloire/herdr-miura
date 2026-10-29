import type { Controller } from "../app/controller";
import { copyPath, openFolder, tildePath } from "../app/folder";
import { relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import { isPending, type Worktree, worktreeName } from "../changes/worktrees";

/// A workspace's linked worktrees in full: each one's branch, last commit,
/// what is still pending in it and where it is, with ways to open it. The
/// list is the live one, so it follows the 10 s reread while open.
export function WorktreesDialog({
  controller,
  workspaceId,
  workspace,
  worktrees,
  onClose,
}: {
  controller: Controller;
  workspaceId: string;
  workspace: string;
  worktrees: Worktree[];
  onClose: () => void;
}) {
  const home = useHome();
  const pending = worktrees.filter(isPending).length;
  const newTab = (path: string) => {
    controller.request("tab.create", { workspace_id: workspaceId, cwd: path, focus: true });
    onClose();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog"
        role="dialog"
        aria-labelledby="worktrees-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <h2 id="worktrees-title">
            {workspace}: {worktrees.length} {worktrees.length === 1 ? "worktree" : "worktrees"}
          </h2>
          <span className="worktrees-summary">{pending > 0 ? `${pending} not merged` : "all merged"}</span>
          <button autoFocus className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <ul className="worktrees-list">
          {worktrees.map((worktree) => (
            <li key={worktree.path} className={isPending(worktree) ? "pending" : undefined}>
              <div className="worktree-line">
                <span className="worktree-name">{worktreeName(worktree)}</span>
                <WorktreeState worktree={worktree} />
              </div>
              {worktree.subject && (
                <div className="worktree-commit">
                  <span className="worktree-subject" title={worktree.subject}>
                    {worktree.subject}
                  </span>
                  {worktree.time !== null && <span className="worktree-when">{relativeTime(worktree.time)}</span>}
                </div>
              )}
              <div className="worktree-path" title={worktree.path}>
                {tildePath(worktree.path, home)}
              </div>
              <div className="worktree-actions">
                <button onClick={() => newTab(worktree.path)}>New tab here</button>
                <button onClick={() => controller.act(openFolder(worktree.path, "vs_code"))}>VS Code</button>
                <button onClick={() => controller.act(openFolder(worktree.path, "files"))}>Folder</button>
                <button onClick={() => controller.act(copyPath(worktree.path))}>Copy path</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/// Commits the default branch lacks and uncommitted files, each in its own
/// color, or that the worktree has nothing left to land.
function WorktreeState({ worktree }: { worktree: Worktree }) {
  const { unmerged, changed, base } = worktree;
  if (!unmerged && !changed) {
    return (
      <span className="worktree-state">
        {unmerged === 0 ? `merged${base ? ` into ${base}` : ""}, clean` : "clean"}
      </span>
    );
  }
  return (
    <span className="worktree-state">
      {unmerged ? (
        <span className="git-ahead" title={base ? `Commits ${base} does not have` : undefined}>
          {unmerged} {unmerged === 1 ? "commit" : "commits"} unmerged
        </span>
      ) : null}
      {changed ? (
        <span className="git-changed">
          {changed} uncommitted {changed === 1 ? "file" : "files"}
        </span>
      ) : null}
    </span>
  );
}
