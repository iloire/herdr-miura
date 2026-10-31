import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { clean } from "../changes/diff";
import { discardFile, discardPlan, discardSummary, promisesCopy, type DiscardPlan } from "../changes/discard";
import type { ChangedFile } from "../changes/store";

type Phase =
  | { name: "reading" }
  | { name: "asking"; plan: DiscardPlan }
  | { name: "running"; plan: DiscardPlan }
  | { name: "refused"; message: string; details: string };

/// Asks before one file's change is thrown away, as `LandDialog` does: Cancel
/// takes the focus, so a stray Enter does nothing. An agent at work is a
/// warning and not a refusal, since its change may be why you are here; the
/// plan's fingerprint still guards the moment of the click.
export function DiscardDialog({
  checkout,
  branch,
  file,
  agent,
  onClose,
  onDiscarded,
}: {
  checkout: string;
  branch: string | null;
  file: ChangedFile;
  /// Who is at work in this checkout, in a sentence.
  agent: string | null;
  onClose: () => void;
  onDiscarded: (file: ChangedFile) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "reading" });
  useEffect(() => {
    let current = true;
    discardPlan(checkout, file.path, branch)
      .then((answer) => {
        if (!current) return;
        if (answer.kind === "ready") setPhase({ name: "asking", plan: answer });
        else setPhase({ name: "refused", message: answer.message, details: "" });
      })
      .catch((error) => current && setPhase({ name: "refused", message: String(error), details: "" }));
    return () => {
      current = false;
    };
  }, [checkout, file.path, branch]);

  const running = phase.name === "running";
  const cancel = () => {
    if (!running) onClose();
  };
  const confirm = async (plan: DiscardPlan) => {
    setPhase({ name: "running", plan });
    try {
      const outcome = await discardFile(checkout, file.path, plan.fingerprint, branch);
      if (outcome.kind === "done") onDiscarded(file);
      else setPhase({ name: "refused", message: outcome.message, details: outcome.details });
    } catch (error) {
      setPhase({ name: "refused", message: String(error), details: "" });
    }
  };
  const plan = phase.name === "asking" || phase.name === "running" ? phase.plan : null;
  const path = clean(file.path);

  return createPortal(
    <div className="palette-backdrop" onMouseDown={cancel}>
      <div
        className="palette host-key land-dialog"
        role="alertdialog"
        aria-labelledby="discard-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && cancel()}
      >
        <h2 id="discard-title">{phase.name === "refused" ? "Nothing was discarded" : "Discard this change?"}</h2>
        <p className="discard-file">
          <code>{path}</code>
          {plan?.additions !== null && plan?.additions !== undefined && (
            <span className="lines">
              <span className="plus">+{plan.additions}</span> <span className="minus">−{plan.deletions}</span>
            </span>
          )}
        </p>
        {phase.name === "reading" && <p>Reading the file…</p>}
        {plan && (
          <p>
            {clean(discardSummary(plan))}
            {promisesCopy(plan) && " A copy goes to the Trash."}
          </p>
        )}
        {plan?.drops_staged && <p className="land-warning">Its staged version is not kept.</p>}
        {plan && agent && <p className="land-warning">{clean(agent)}</p>}
        {phase.name === "refused" && (
          <>
            <p className="host-key-error">{clean(phase.message)}</p>
            {phase.details && <pre className="discard-details">{phase.details.split("\n").map(clean).join("\n")}</pre>}
          </>
        )}
        <div className="host-key-actions">
          <button autoFocus className="host-key-button" disabled={running} onClick={cancel}>
            {phase.name === "refused" ? "Close" : "Cancel"}
          </button>
          {phase.name !== "refused" && (
            <button
              className="host-key-button primary"
              disabled={phase.name !== "asking"}
              onClick={() => plan && void confirm(plan)}
            >
              {running ? "Discarding…" : "Discard"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
