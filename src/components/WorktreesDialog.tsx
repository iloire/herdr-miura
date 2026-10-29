import type { CSSProperties } from "react";
import type { Controller } from "../app/controller";
import { copyPath, openFolder, tildePath } from "../app/folder";
import { hueColor } from "../app/hue";
import { relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import { isPending, type Worktree, worktreeName } from "../changes/worktrees";
import { CodeIcon, CopyIcon, FolderIcon, OpenIcon, TerminalIcon } from "./icons";

/// A workspace's linked worktrees in full: each one's branch, what is still
/// pending in it, its last commit and where it is, with ways to open it. The
/// list is the live one, so it follows the 10 s reread while open. Worktrees
/// holding work come first: they are the ones to land or drop.
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
  const sorted = [...worktrees].sort((a, b) => Number(isPending(b)) - Number(isPending(a)));
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
        style={{ "--hue": hueColor(workspace) } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Worktrees</span>
            <h2 id="worktrees-title">{workspace}</h2>
            <p className="worktrees-summary">{summary(worktrees)}</p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <ul className="worktrees-list">
          {sorted.map((worktree) => (
            <li key={worktree.path} className={`worktree ${isPending(worktree) ? "pending" : "landed"}`}>
              <div className="worktree-top">
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
                <FolderIcon />
                <span>{tildePath(worktree.path, home)}</span>
              </div>
              <div className="worktree-actions">
                <button className="primary" onClick={() => newTab(worktree.path)}>
                  <TerminalIcon />
                  New tab here
                </button>
                <button onClick={() => controller.act(openFolder(worktree.path, "vs_code"))}>
                  <CodeIcon />
                  VS Code
                </button>
                <button onClick={() => controller.act(openFolder(worktree.path, "files"))}>
                  <OpenIcon />
                  Folder
                </button>
                <button onClick={() => controller.act(copyPath(worktree.path))}>
                  <CopyIcon />
                  Copy path
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/// One sentence under the title: how many, and how many still hold work.
function summary(worktrees: Worktree[]): string {
  const pending = worktrees.filter(isPending).length;
  const base = worktrees.find((worktree) => worktree.base)?.base;
  const onto = base ? ` on ${base}` : " merged";
  const total = worktrees.length;
  if (pending === 0) return total === 1 ? `1 worktree, merged and clean.` : `${total} worktrees, all merged and clean.`;
  if (pending === total) {
    return total === 1 ? `1 worktree, holding work not yet${onto}.` : `${total} worktrees, all holding work not yet${onto}.`;
  }
  return `${total} worktrees, ${pending} holding work not yet${onto}.`;
}

/// Commits the default branch lacks and uncommitted files, each a pill in
/// its own color, or one quiet pill when nothing is left to land.
function WorktreeState({ worktree }: { worktree: Worktree }) {
  const { unmerged, changed, base } = worktree;
  if (!unmerged && !changed) {
    return (
      <span className="worktree-pills">
        <span className="worktree-pill quiet">{unmerged === 0 ? "Merged and clean" : "Clean"}</span>
      </span>
    );
  }
  return (
    <span className="worktree-pills">
      {unmerged ? (
        <span className="worktree-pill unmerged">
          {unmerged} {unmerged === 1 ? "commit" : "commits"} not on {base ?? "the default branch"}
        </span>
      ) : null}
      {changed ? (
        <span className="worktree-pill uncommitted">
          {changed} uncommitted {changed === 1 ? "file" : "files"}
        </span>
      ) : null}
    </span>
  );
}
