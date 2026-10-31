import { useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { clean } from "../changes/diff";
import { canCommit, canTick, commitPaths, keepListed, tickState, toggleAll } from "../changes/fileActions";
import type { ChangedFile, CheckoutChanges } from "../changes/store";
import { IDLE, type CheckoutSync, type SyncOutcome, type SyncStore } from "../changes/sync";
import { FileRow } from "./CommitList";

const NO_SYNC: ReadonlyMap<string, CheckoutSync> = new Map();
const noSubscription = () => () => {};
const noSync = () => NO_SYNC;

const filesLabel = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

type Failure = Extract<SyncOutcome, { kind: "failed" }>;

/// The checkout's changed files under their count, each with a tick box where
/// it can be committed, a box on the count for all of them, and the message box
/// once something is ticked. A tick is
/// forgotten when its file leaves the list. A failed commit keeps the ticks and
/// the message, so fixing what a hook said costs one more click.
export function ChangedFiles({
  checkout,
  sync,
  selected,
  onOpen,
  onMenu,
  onCommitted,
}: {
  checkout: CheckoutChanges;
  sync: SyncStore | null;
  selected: ChangedFile | null;
  onOpen: (file: ChangedFile) => void;
  onMenu: (event: MouseEvent, file: ChangedFile) => void;
  onCommitted: () => void;
}) {
  const [ticks, setTicks] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const syncs = useSyncExternalStore(sync?.subscribe ?? noSubscription, sync?.getState ?? noSync);
  const syncing = (syncs.get(checkout.path) ?? IDLE).running !== null;

  const { files } = checkout;
  const kept = keepListed(ticks, files);
  if (kept !== ticks) setTicks(kept);
  const tickable = sync !== null && canCommit(checkout);
  const ticked = tickable ? files.filter((file) => kept.has(file.path)) : [];
  const listTick = tickable && files.some(canTick);
  const allTicks = tickState(kept, files);
  const count = checkout.total_files === 0 ? "No uncommitted changes" : `${checkout.total_files} changed`;

  const toggle = (path: string) => {
    const next = new Set(kept);
    if (!next.delete(path)) next.add(path);
    setTicks(next);
  };

  const ready = ticked.length > 0 && message.trim() !== "" && !committing && !syncing;
  const commit = async () => {
    if (!ready) return;
    setCommitting(true);
    setFailure(null);
    let outcome: SyncOutcome;
    try {
      outcome = await commitPaths(checkout.path, ticked.map((file) => file.path), message, checkout.branch);
    } catch (error) {
      outcome = { kind: "failed", reason: "other", message: String(error), details: "" };
    }
    setCommitting(false);
    if (outcome.kind === "failed") setFailure(outcome);
    else {
      setTicks(new Set());
      setMessage("");
    }
    onCommitted();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void commit();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void commit();
  };

  return (
    <>
      <h3 className={listTick ? "changes-section changes-section-ticks" : "changes-section"}>
        {listTick ? (
          <label>
            <input
              type="checkbox"
              className="file-tick"
              aria-label={allTicks === "all" ? "Untick all files" : "Tick all files"}
              title={allTicks === "all" ? "Untick all files" : "Tick all files"}
              checked={allTicks === "all"}
              ref={(box) => {
                if (box) box.indeterminate = allTicks === "some";
              }}
              onChange={() => setTicks(toggleAll(kept, files))}
            />
            {count}
          </label>
        ) : (
          count
        )}
        {checkout.total_files > 0 && (
          <span className="lines">
            <span className="plus">+{checkout.added}</span> <span className="minus">−{checkout.removed}</span>
          </span>
        )}
      </h3>
      <ul className="file-list">
        {files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            current={selected?.path === file.path}
            onOpen={() => onOpen(file)}
            onMenu={(event) => onMenu(event, file)}
            tick={tickable && canTick(file) ? { checked: kept.has(file.path), onChange: () => toggle(file.path) } : undefined}
          />
        ))}
      </ul>
      {ticked.length > 0 && (
        <form className="commit-box" onSubmit={onSubmit}>
          <textarea
            aria-label="Commit message"
            placeholder="Commit message"
            rows={2}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="submit"
            className="sync-action sync-main"
            disabled={!ready}
            title={`Commit ${filesLabel(ticked.length)} on ${checkout.branch} (⌘↩). Nothing else goes in, and nothing is pushed.`}
          >
            {committing ? "Committing…" : `Commit ${filesLabel(ticked.length)}`}
          </button>
          {failure && (
            <div className="sync-result failed" role="status">
              <p>{clean(failure.message)}</p>
              {failure.details && <pre>{failure.details.split("\n").map(clean).join("\n")}</pre>}
              <button type="button" className="sync-dismiss" aria-label="Dismiss" title="Dismiss" onClick={() => setFailure(null)}>
                ×
              </button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
