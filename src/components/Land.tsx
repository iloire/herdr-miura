import { createPortal } from "react-dom";
import { clean } from "../changes/diff";
import type { Land, LandPlan, LandStep } from "../changes/land";
import { worktreeName } from "../changes/worktrees";

const commits = (count: number) => `${count} ${count === 1 ? "commit" : "commits"}`;

const RUNNING: Record<LandStep, string> = {
  start: "starting",
  check: "running the check",
  rebase: "rebasing",
  fast_forward: "fast-forwarding",
  remove: "removing the worktree",
  delete_branch: "deleting the branch",
  confirm: "confirming",
};

const STOPPED: Record<LandStep, string> = {
  start: "Did not start",
  check: "Stopped at the check",
  rebase: "Stopped at the rebase",
  fast_forward: "Stopped at the fast-forward",
  remove: "Stopped removing the worktree",
  delete_branch: "Stopped deleting the branch",
  confirm: "Stopped confirming the result",
};

/// Asks before a land, naming all it will do. Cancel takes the focus, as a
/// stray Enter must never rewrite a branch and delete a worktree. In `body`,
/// since the sidebar it opens from clips what it holds.
export function LandDialog({
  plan,
  path,
  openIn,
  onCancel,
  onConfirm,
}: {
  plan: LandPlan;
  path: string;
  /// The workspace open on the worktree, when there is one.
  openIn: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onCancel}>
      <div
        className="palette host-key land-dialog"
        role="alertdialog"
        aria-labelledby="land-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
      >
        <h2 id="land-title">
          Land {plan.branch} on {plan.main}?
        </h2>
        <ol className="land-steps">
          {plan.check ? (
            <li>
              Run <code>{clean(plan.check)}</code> in the worktree.
            </li>
          ) : (
            <li className="land-warning">
              This repo has no check, so nothing is tested first. Add a <code>check</code> script, a <code>check:</code> make
              target, or <code>.herdr/land.json</code>.
            </li>
          )}
          <li>
            Rebase its {commits(plan.commits)} onto {plan.main}.
          </li>
          <li>Fast-forward {plan.main} in the main checkout.</li>
          <li>
            Remove the worktree and delete {plan.branch}: <code>{path}</code>
          </li>
        </ol>
        {openIn && (
          <p className="land-warning">
            Workspace {openIn} stays open on the worktree, and its folder will be gone.
          </p>
        )}
        <p>Nothing is pushed, and it stops at the first failure.</p>
        <div className="host-key-actions">
          <button autoFocus className="host-key-button" onClick={onCancel}>
            Cancel
          </button>
          <button className="host-key-button primary" onClick={onConfirm}>
            Land
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/// A land on the card that started it, collapsed or not: its current step, or
/// how it ended. The worktree's own row is gone by then, so this is the result.
export function LandNote({ land, onDismiss }: { land: Land; onDismiss: () => void }) {
  if (land.phase === "asking") return null;
  if (land.phase !== "ended") {
    const step = land.phase === "running" ? RUNNING[land.step] : "reading";
    return (
      <div className="land-note" role="status">
        <p className="sync-result">
          Landing {worktreeName(land.worktree)}: <span className="sync-running">{step}…</span>
        </p>
      </div>
    );
  }
  const { branch, outcome } = land;
  const failed = outcome.kind === "failed";
  return (
    <div className="land-note" role="status">
      <div className={`sync-result ${failed ? "failed" : ""}`}>
        {failed ? (
          <>
            <p>
              {STOPPED[outcome.step]}: {outcome.message}
            </p>
            <p className="land-left">{outcome.left}</p>
            {outcome.details && <pre>{outcome.details.split("\n").map(clean).join("\n")}</pre>}
          </>
        ) : (
          <p>
            Landed {branch}: {commits(outcome.commits)} on {outcome.main}. Worktree and branch removed. Nothing was pushed.
          </p>
        )}
        <button className="sync-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          ×
        </button>
      </div>
    </div>
  );
}
