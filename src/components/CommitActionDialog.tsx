import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { branchFromCommit, revertCommit } from "../changes/commitActions";
import { clean } from "../changes/diff";
import type { RecentCommit } from "../changes/store";
import type { SyncOutcome } from "../changes/sync";

export type CommitAction = "branch" | "revert";

type Phase = { name: "asking" } | { name: "running" } | { name: "refused"; message: string; details: string };

/// Asks for a new branch's name, or confirms a revert, for one commit. As
/// `DiscardDialog`, a revert's Cancel takes the focus so a stray Enter does
/// nothing; the branch name field takes it for the other. The backend checks
/// the tree again at the click, and its refusal shows here with Git's words.
export function CommitActionDialog({
  action,
  checkout,
  branch,
  commit,
  onClose,
  onDone,
}: {
  action: CommitAction;
  checkout: string;
  /// The branch the panel shows, which a revert lands on.
  branch: string | null;
  commit: RecentCommit;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "asking" });
  const [name, setName] = useState("");
  const dismiss = useRef<HTMLButtonElement>(null);
  const refused = phase.name === "refused";
  useEffect(() => {
    if (refused) dismiss.current?.focus();
  }, [refused]);

  const running = phase.name === "running";
  const cancel = () => {
    if (!running) onClose();
  };
  const run = async () => {
    setPhase({ name: "running" });
    let outcome: SyncOutcome;
    try {
      outcome =
        action === "branch"
          ? await branchFromCommit(checkout, commit.sha, name.trim())
          : await revertCommit(checkout, commit.sha, branch);
    } catch (error) {
      outcome = { kind: "failed", reason: "other", message: String(error), details: "" };
    }
    // A conflicted revert still changed the checkout, so the panel reads it again either way.
    onDone();
    if (outcome.kind === "done") onClose();
    else setPhase({ name: "refused", message: outcome.message, details: outcome.details });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (phase.name === "asking" && (action === "revert" || name.trim())) void run();
  };
  const subject = clean(commit.subject);
  const title =
    action === "branch"
      ? refused
        ? "No branch was started"
        : "New branch here"
      : refused
        ? "Not reverted"
        : "Revert this commit?";

  return createPortal(
    <div className="palette-backdrop" onMouseDown={cancel}>
      <form
        className="palette host-key land-dialog"
        role="alertdialog"
        aria-labelledby="commit-action-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && cancel()}
        onSubmit={onSubmit}
      >
        <h2 id="commit-action-title">{title}</h2>
        <p className="discard-file">
          <code>{commit.short}</code>
          <span className="commit-action-subject">{subject}</span>
        </p>
        {action === "branch" && !refused && (
          <>
            <p>Starts a branch at this commit and switches the checkout to it.</p>
            <input
              className="commit-action-name"
              aria-label="Branch name"
              placeholder="Branch name"
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={running}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </>
        )}
        {action === "revert" && !refused && (
          <p>
            Adds a commit on <b>{branch}</b> that undoes it. Nothing is pushed. On a conflict, Git stops halfway and
            the panel shows the revert under way, to finish in a terminal.
          </p>
        )}
        {phase.name === "refused" && (
          <>
            <p className="host-key-error">{clean(phase.message)}</p>
            {phase.details && <pre className="discard-details">{phase.details.split("\n").map(clean).join("\n")}</pre>}
          </>
        )}
        <div className="host-key-actions">
          <button
            type="button"
            ref={dismiss}
            autoFocus={action === "revert"}
            className="host-key-button"
            disabled={running}
            onClick={cancel}
          >
            {refused ? "Close" : "Cancel"}
          </button>
          {!refused && (
            <button
              type="submit"
              className="host-key-button primary"
              disabled={running || (action === "branch" && !name.trim())}
            >
              {action === "branch" ? (running ? "Starting…" : "Create and switch") : running ? "Reverting…" : "Revert"}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
