import { type CSSProperties, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tildePath } from "../app/folder";
import { readItemCommits, title, type Item, worktreeBranch } from "../app/queue";
import { formatMoment, formatSpan, relativeTime } from "../app/time";
import { useCopied } from "../app/useCopied";
import { useHome } from "../app/useHome";
import type { RecentCommit } from "../changes/store";
import { CheckIcon, CopyIcon, TerminalIcon } from "./icons";

const STATE_WORDS = { done: "Done", failed: "Failed", stopped: "Stopped" } as Partial<Record<Item["state"], string>>;

/// A finished prompt in full: its whole text, the commits it left, when it ran
/// and where it came from. The timeline is the queue's track again, one stop
/// for each moment, with the time between two along the line.
export function QueueItemDialog({
  item,
  folder,
  hue,
  onGo,
  onClose,
}: {
  item: Item;
  folder: string;
  /// The workspace's color.
  hue: string;
  /// Goes to its tab; null once the tab is gone.
  onGo: (() => void) | null;
  onClose: () => void;
}) {
  const home = useHome();
  const { copied, copy } = useCopied(item.prompt);
  const ok = item.state === "done";
  const state = STATE_WORDS[item.state] ?? item.state;
  // Back to the row that opened it, since a closed dialog leaves focus nowhere.
  // Read while rendering: the close button takes focus before an effect runs.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog queue-item-dialog"
        role="dialog"
        aria-labelledby="queue-item-title"
        // A click on the text must leave focus inside, for Escape.
        tabIndex={-1}
        style={{ "--hue": hue } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Prompt #{item.n}</span>
            <h2 id="queue-item-title">{title(item.prompt, 100)}</h2>
            <p className={`worktrees-summary ${ok ? "" : "queue-item-bad"}`}>
              {item.reason ? `${state}: ${item.reason}` : state}
              {item.finished ? ` · ${relativeTime(item.finished / 1000)}` : ""}
            </p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="queue-item-body">
          <div className="queue-item-main">
            <p className="queue-item-prompt">{item.prompt}</p>
            <ItemCommits item={item} folder={folder} />
          </div>
          <div className="queue-item-side">
            <ol className="queue-item-run" aria-label="When it ran">
              <Moment label="Added" at={item.added} until={item.started} span="Waited" />
              {item.started && <Moment label="Started" at={item.started} until={item.finished} span="Ran" />}
              {item.finished && <Moment label={state} at={item.finished} last={ok ? "ok" : "bad"} />}
            </ol>
            <dl className="queue-item-facts">
              <dt>Queued from</dt>
              <dd>{item.source === undefined ? "This panel" : item.source || "An agent"}</dd>
              <dt>Ran in</dt>
              <dd title={item.worktree ?? folder}>{tildePath(item.worktree ?? folder, home)}</dd>
              {item.worktree && (
                <>
                  <dt>Branch</dt>
                  <dd>{worktreeBranch(item.worktree)}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
        <footer className="worktree-actions queue-item-actions">
          {onGo && (
            <button className="primary" onClick={onGo}>
              <TerminalIcon />
              Open tab
            </button>
          )}
          <button onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Moment({
  label,
  at,
  until,
  span,
  last,
}: {
  label: string;
  at: number;
  /// The next moment, and what to call the time up to it.
  until?: number;
  span?: string;
  last?: "ok" | "bad";
}) {
  return (
    <li className={last ?? ""}>
      <span className="queue-item-moment">{label}</span>
      <time dateTime={new Date(at).toISOString()}>{formatMoment(at)}</time>
      {until && (
        <span className="queue-item-span">
          {span} {formatSpan(until - at)}
        </span>
      )}
    </li>
  );
}

type Commits = { phase: "loading" } | { phase: "ready"; commits: RecentCommit[] } | { phase: "failed"; error: string };

/// What the prompt committed, read from its checkout when opened. Only a prompt
/// that finished was counted; a stopped one has no count to go by.
function ItemCommits({ item, folder }: { item: Item; folder: string }) {
  const [read, setRead] = useState<Commits>({ phase: "loading" });
  const { head, commits: count } = item;
  const directory = item.worktree ?? folder;
  useEffect(() => {
    if (!head || !count) return;
    let current = true;
    setRead({ phase: "loading" });
    readItemCommits(directory, head, count)
      .then((commits) => current && setRead({ phase: "ready", commits }))
      .catch((error) => current && setRead({ phase: "failed", error: String(error) }));
    return () => {
      current = false;
    };
  }, [directory, head, count]);
  if (count === undefined) return null;
  return (
    <section className="queue-item-commits">
      <h3>{count === 1 ? "1 commit" : `${count} commits`}</h3>
      {read.phase === "loading" && count > 0 && <p className="empty">Reading the commits…</p>}
      {read.phase === "failed" && (
        <p className="empty error" title={read.error}>
          {item.worktree ? "Its worktree cannot be read, so it may have been removed." : `Could not read the commits: ${read.error}`}
        </p>
      )}
      {read.phase === "ready" && count > 0 && (
        <ul>
          {read.commits.map((commit) => (
            <li key={commit.sha}>
              <span className="sha" title={commit.sha}>
                {commit.short}
              </span>
              <span className="queue-item-subject" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="queue-item-when">{relativeTime(commit.time)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
