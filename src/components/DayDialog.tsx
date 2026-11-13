import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tildePath } from "../app/folder";
import { allParked, asksForYou, dayView, doneToday, isOpen, olderOpen, type Outcome, repoName, STALE_DAYS, waitingOnYou } from "../app/ledger";
import { relativeTime } from "../app/time";
import { completedToday, type Linked, offer } from "../app/todoistLinks";
import { useHome } from "../app/useHome";

const MARKS: Record<string, { mark: string; words: string }> = {
  verified: { mark: "✓", words: "Done" },
  unverified: { mark: "◐", words: "Done, unverified" },
  left: { mark: "◌", words: "Parked" },
  you: { mark: "!", words: "Needs you" },
  "not-started": { mark: "?", words: "Not started" },
};

const RESOLVED: Record<string, string> = { queued: "queued", dismissed: "dismissed", cleared: "cleared", todo: "sent to Todoist" };

/// What was written back to a task, in the row's facts.
const WRITTEN: Record<string, string> = { closed: "completed in Todoist", subtask: "subtask in Todoist", commented: "noted in Todoist" };

/// What each agent reported today, across every repo, from the outcome ledger,
/// and whatever is still open from before: the end-of-day view of what landed,
/// what was left and what waits on you. Rows that are still open act there.
/// An outcome whose prompt came from a Todoist task names it, and offers to
/// complete it (a verified done) or add a subtask (a parked note).
export function DayDialog({
  list,
  now,
  live,
  onGo,
  onResume,
  onQueue,
  onResolve,
  linked,
  onTodoist,
  onClose,
}: {
  list: Outcome[];
  now: number;
  /// Sessions a tab holds now, by session id, with that tab.
  live: ReadonlyMap<string, string>;
  onGo: (tabId: string) => void;
  /// Resumes a closed session in a workspace on its repo.
  onResume: (outcome: Outcome) => void;
  /// Puts a parked note in its repo's queue; null without a queue here.
  onQueue: ((outcome: Outcome) => void) | null;
  onResolve: (outcome: Outcome, how: "dismissed" | "cleared") => void;
  /// Ledger entries by id, with the Todoist task their prompt came from.
  linked: ReadonlyMap<string, Linked>;
  /// Writes an outcome back to its task, when asked.
  onTodoist: (outcome: Outcome) => void;
  onClose: () => void;
}) {
  const home = useHome();
  // Read once as the dialog opens; without a token it is left out.
  const [completed, setCompleted] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    completedToday(now)
      .then((count) => live && setCompleted(count))
      .catch(() => {});
    return () => {
      live = false;
    };
    // The count is of the moment the dialog opened, not of every render's `now`.
  }, []);
  const [older, setOlder] = useState(false);
  const groups = dayView(list, now, older);
  const hidden = olderOpen(list).length;
  const done = doneToday(list, now).length;
  const parked = allParked(list).length;
  const waiting = waitingOnYou(list).length;
  const summary = [
    `${done} done today`,
    `${parked} parked`,
    waiting > 0 && `${waiting} waiting on you`,
    completed !== null && `${completed} completed in Todoist`,
  ]
    .filter(Boolean)
    .join(" · ");
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog day-dialog"
        role="dialog"
        aria-labelledby="day-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Today</span>
            <h2 id="day-title">What the agents did</h2>
            <p className="worktrees-summary">{summary}</p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        {groups.length === 0 ? (
          <p className="day-empty">
            Nothing reported yet today. Agents report with <code>herdr-outcome</code> as their last command.
          </p>
        ) : (
          <div className="day-body">
            {groups.map((group) => (
              <section key={group.home} className="day-repo">
                <h3 title={group.home}>
                  {repoName(group.home)} <span>{tildePath(group.home, home)}</span>
                </h3>
                <ul>
                  {group.outcomes.map((outcome) => (
                    <Row
                      key={outcome.id}
                      outcome={outcome}
                      tab={live.get(outcome.session) ?? null}
                      onGo={onGo}
                      onResume={onResume}
                      onQueue={onQueue}
                      onResolve={onResolve}
                      linked={linked.get(outcome.id)}
                      onTodoist={onTodoist}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {hidden > 0 && (
          <button
            className="day-older"
            title={`Parked notes older than ${STALE_DAYS.left} days and asks older than ${STALE_DAYS.you} days, still open`}
            onClick={() => setOlder(!older)}
          >
            {older ? `Hide the ${hidden} older ones` : `Show ${hidden} older, still open`}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Row({
  outcome,
  tab,
  onGo,
  onResume,
  onQueue,
  onResolve,
  linked,
  onTodoist,
}: {
  outcome: Outcome;
  tab: string | null;
  onGo: (tabId: string) => void;
  onResume: (outcome: Outcome) => void;
  onQueue: ((outcome: Outcome) => void) | null;
  onResolve: (outcome: Outcome, how: "dismissed" | "cleared") => void;
  linked: Linked | undefined;
  onTodoist: (outcome: Outcome) => void;
}) {
  const { mark, words } = MARKS[outcome.kind] ?? { mark: "·", words: outcome.kind };
  const open = isOpen(outcome);
  const later = outcome.resolved ? RESOLVED[outcome.resolved.how] ?? outcome.resolved.how : outcome.superseded && asksForYou(outcome.kind) ? "answered" : null;
  // A subtask also resolves its parked note as `todo`, which already says so.
  const written = [...(linked?.written ?? [])].filter((did) => !(did === "subtask" && outcome.resolved?.how === "todo")).map((did) => WRITTEN[did] ?? did);
  const facts = [words, outcome.branch, relativeTime(outcome.time / 1000), later ?? (open && outcome.stale ? "older" : null), ...written]
    .filter(Boolean)
    .join(" · ");
  const todoist = offer(outcome, linked);
  return (
    <li className={`day-row kind-${outcome.kind} ${open ? "open" : ""}`}>
      <span className="day-mark" aria-hidden>
        {mark}
      </span>
      <div className="day-text">
        {outcome.note && <p title={outcome.note}>{outcome.note}</p>}
        <span className="day-facts">{facts}</span>
        {linked && (
          <span className="day-task" title={`Sent from the Todoist task ${linked.link.title}`}>
            ☐ {linked.link.title}
          </span>
        )}
      </div>
      <div className="day-actions">
        {tab && (
          <button title="Go to its tab" onClick={() => onGo(tab)}>
            Go
          </button>
        )}
        {!tab && outcome.session && asksForYou(outcome.kind) && open && (
          <button title="Open a tab resuming that session" onClick={() => onResume(outcome)}>
            Resume
          </button>
        )}
        {todoist && linked && (
          <button
            title={
              todoist === "close"
                ? `Complete “${linked.link.title}” in Todoist, with a comment naming the commits`
                : `Add this as a subtask of “${linked.link.title}” in Todoist`
            }
            onClick={() => onTodoist(outcome)}
          >
            {todoist === "close" ? "Complete in Todoist" : "Add to Todoist"}
          </button>
        )}
        {open && outcome.kind === "left" && onQueue && (
          <button title="Add it to the end of its repo's queue as a prompt" onClick={() => onQueue(outcome)}>
            Queue it
          </button>
        )}
        {open && (
          <button
            className="day-quiet"
            title={outcome.kind === "left" ? "Nothing to do about it" : "Dealt with: stop listing it"}
            onClick={() => onResolve(outcome, outcome.kind === "left" ? "dismissed" : "cleared")}
          >
            {outcome.kind === "left" ? "Dismiss" : "Clear"}
          </button>
        )}
      </div>
    </li>
  );
}
