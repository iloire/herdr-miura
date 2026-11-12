import { useCallback, useEffect, useState } from "react";
import { relativeTime } from "../app/time";
import { deleteBranch, readBranches, switchBlock, switchBranch, tracking, type Branches } from "../changes/branches";
import { clean } from "../changes/diff";
import type { CheckoutChanges } from "../changes/store";
import type { SyncOutcome } from "../changes/sync";

type Failure = Extract<SyncOutcome, { kind: "failed" }>;

/// The checkout's local branches, newest commit first, opened from the branch
/// name. A branch switches the checkout only on a clean tree with nothing under
/// way, and a row that cannot says why. Below, the branches merged into the
/// default branch, each deleted with `git branch -d` after a confirmation.
/// `writable` is false on a remote host, where the list only reads.
export function BranchList({
  checkout,
  writable,
  onWritten,
}: {
  checkout: CheckoutChanges;
  writable: boolean;
  onWritten: () => void;
}) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const load = useCallback(() => {
    readBranches(checkout.path).then(
      (read) => {
        setBranches(read);
        setError(null);
      },
      (failed) => setError(String(failed)),
    );
  }, [checkout.path]);
  // Again when HEAD moves, by a switch here or anywhere else.
  useEffect(load, [load, checkout.branch, checkout.commits[0]?.sha]);

  const act = async (write: () => Promise<SyncOutcome>) => {
    setBusy(true);
    setFailure(null);
    let outcome: SyncOutcome;
    try {
      outcome = await write();
    } catch (failed) {
      outcome = { kind: "failed", reason: "other", message: String(failed), details: "" };
    }
    setBusy(false);
    setConfirming(null);
    if (outcome.kind === "failed") setFailure(outcome);
    onWritten();
    load();
  };

  if (error) return <p className="empty error">Could not list the branches: {error}</p>;
  if (!branches) return <p className="empty">Reading the branches…</p>;
  const more = branches.total - branches.branches.length;
  return (
    <div className="branch-list">
      <ul>
        {branches.branches.map((branch) => {
          const block = switchBlock(checkout, branch);
          const stats = tracking(branch);
          return (
            <li key={branch.name}>
              <button
                className="branch-row"
                aria-current={branch.current ? "true" : undefined}
                disabled={!writable || block !== null || busy}
                title={
                  branch.current
                    ? `${branch.name} is checked out here`
                    : block
                      ? `Can't switch to ${branch.name}: ${block}`
                      : `Switch this checkout to ${branch.name}`
                }
                onClick={() => void act(() => switchBranch(checkout.path, branch.name, checkout.branch))}
              >
                <bdi className="branch-row-name">{branch.name}</bdi>
                {stats && (
                  <span className="branch-row-track" title={branch.upstream ? `Against ${branch.upstream}` : undefined}>
                    {stats}
                  </span>
                )}
                <span className="branch-row-hint">
                  {block && !branch.current && writable ? block : relativeTime(branch.time)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && <p className="empty">and {more} older branches</p>}
      {writable && branches.base && branches.merged.length > 0 && (
        <>
          <h4 className="branch-list-title">Merged into {branches.base}</h4>
          <ul>
            {branches.merged.map((name) =>
              confirming === name ? (
                <li key={name} className="branch-confirm" role="alertdialog" aria-label={`Delete ${name}?`}>
                  <span>
                    Delete <b>{name}</b>? Git keeps it if any commit would be lost.
                  </span>
                  <button autoFocus className="sync-action" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button
                    className="sync-action danger"
                    disabled={busy}
                    onClick={() => void act(() => deleteBranch(checkout.path, name))}
                  >
                    {busy ? "Deleting…" : "Delete"}
                  </button>
                </li>
              ) : (
                <li key={name} className="branch-merged">
                  <bdi className="branch-row-name">{name}</bdi>
                  <button
                    className="sync-action"
                    disabled={busy}
                    title={`Delete ${name} with git branch -d`}
                    onClick={() => setConfirming(name)}
                  >
                    Delete…
                  </button>
                </li>
              ),
            )}
          </ul>
        </>
      )}
      {failure && (
        <div className="sync-result failed" role="status">
          <p>{clean(failure.message)}</p>
          {failure.details && <pre>{failure.details.split("\n").map(clean).join("\n")}</pre>}
          <button type="button" className="sync-dismiss" aria-label="Dismiss" title="Dismiss" onClick={() => setFailure(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
