import { useState, useSyncExternalStore } from "react";
import { relativeTime } from "../app/time";
import { clean } from "../changes/diff";
import type { CheckoutChanges, Direction } from "../changes/store";
import { IDLE, syncOffer, type SyncNote, type SyncOp, type SyncStore } from "../changes/sync";
import { useMovingCommits } from "../changes/useMovingCommits";
import { CommitList, type CommitRows } from "./CommitList";

const RUNNING: Record<SyncOp, string> = {
  fetch: "fetching…",
  push: "pushing…",
  publish: "publishing…",
  pull: "pulling…",
};

const DONE: Record<SyncOp, string> = { fetch: "Fetched", push: "Pushed", publish: "Published", pull: "Pulled" };

/// The checkout against its remote: what is ahead and behind and when that was
/// last checked, with a word beside each count to move those commits. Clicking
/// a count only lists them, so looking can never push.
export function ChangesSync({
  store,
  checkout,
  rows,
}: {
  store: SyncStore;
  checkout: CheckoutChanges;
  rows: CommitRows;
}) {
  const sync = useSyncExternalStore(store.subscribe, store.getState).get(checkout.path) ?? IDLE;
  const offer = syncOffer(checkout);
  const [picked, setPicked] = useState<Direction | null>(null);
  const counts: Record<Direction, number> = { outgoing: checkout.ahead, incoming: checkout.behind };
  // A list ends with its commits, rather than coming back with the next ones.
  if (picked && counts[picked] === 0) setPicked(null);
  const direction = offer.tracked && picked ? picked : null;
  const moving = useMovingCommits(
    checkout.path,
    direction,
    `${checkout.ahead}/${checkout.behind}/${checkout.commits[0]?.sha}`,
  );
  if (checkout.remotes.length === 0) return null;

  const busy = sync.running !== null;
  const run = (op: SyncOp) => void store.run(checkout.path, op, checkout.branch);
  const count = (which: Direction, arrow: string, label: string) =>
    offer.tracked ? (
      <button
        className="sync-count"
        aria-expanded={direction === which}
        aria-label={`${counts[which]} ${label}`}
        title={`List the ${counts[which]} ${label}`}
        onClick={() => setPicked(direction === which ? null : which)}
      >
        {arrow}
        {counts[which]}
      </button>
    ) : (
      <span className="counts">
        {arrow}
        {counts[which]}
      </span>
    );
  const action = (op: SyncOp, label: string, title: string) => (
    <button className="sync-action" disabled={busy} title={title} onClick={() => run(op)}>
      {label}
    </button>
  );

  return (
    <div className="sync">
      <div className="sync-line">
        {checkout.ahead > 0 && (
          <span className="sync-group">
            {count("outgoing", "↑", "commits to push")}
            {offer.tracked && action("push", "Push", `git push to ${checkout.upstream}`)}
          </span>
        )}
        {checkout.behind > 0 && (
          <span className="sync-group">
            {count("incoming", "↓", "commits to pull")}
            {offer.tracked && action("pull", "Pull", `git pull --ff-only from ${checkout.upstream}`)}
          </span>
        )}
        {offer.publish && action("publish", "Publish", `git push -u origin ${checkout.branch}`)}
        <span className="sync-fetched" title={sync.fetchError ?? undefined}>
          {busy ? (
            <span className="sync-running">{RUNNING[sync.running!]}</span>
          ) : sync.fetchError ? (
            "fetch failed"
          ) : (
            sync.fetchedAt !== null && `fetched ${relativeTime(sync.fetchedAt / 1000)}`
          )}
        </span>
      </div>
      {offer.note && <p className="sync-note">{offer.note}</p>}
      {sync.note && (
        <Note
          note={sync.note}
          onPull={busy ? null : () => run("pull")}
          onDismiss={() => store.dismiss(checkout.path)}
        />
      )}
      {direction && (
        <div className="sync-moving">
          <h3 className="changes-section">
            {counts[direction]} to {direction === "outgoing" ? "push" : "pull"}
          </h3>
          {moving?.phase === "loading" && <p className="empty">Reading the commits…</p>}
          {moving?.phase === "failed" && <p className="empty error">Could not read the commits: {moving.error}</p>}
          {moving?.phase === "ready" && (
            <>
              <CommitList commits={moving.commits} rows={rows} />
              {counts[direction] > moving.commits.length && (
                <p className="empty">and {counts[direction] - moving.commits.length} more not listed</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/// How the last push, publish or pull went. Git's text comes from the remote
/// and its hooks, so it is cleaned as a diff is.
function Note({ note, onPull, onDismiss }: { note: SyncNote; onPull: (() => void) | null; onDismiss: () => void }) {
  const { op, outcome, at } = note;
  const failed = outcome.kind === "failed";
  return (
    <div className={`sync-result ${failed ? "failed" : ""}`} role="status">
      <p>{failed ? outcome.message : `${DONE[op]} ${relativeTime(at / 1000)}.`}</p>
      {failed && outcome.details && <pre>{outcome.details.split("\n").map(clean).join("\n")}</pre>}
      {failed && outcome.reason === "rejected" && (
        <button className="sync-action" disabled={!onPull} title="git pull --ff-only" onClick={() => onPull?.()}>
          Pull
        </button>
      )}
      <button className="sync-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
