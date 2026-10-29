import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import { emptyQueue, isActive, type Item, type Queue, title } from "../app/queue";
import type { QueueActions } from "../app/useQueue";
import type { Snapshot, Workspace } from "../protocol";
import { PauseIcon, PlayIcon, TerminalIcon } from "./icons";
import { StatusMark } from "./StatusMark";

/// How long a removed prompt can be brought back.
const UNDO_MS = 5000;

/// A workspace's prompt queue: what runs now, what is next, what is done, and
/// a box to add more. Drawn like the worktrees dialog. The box takes focus, so
/// ⌘⇧A, paste, ⌘↵, Esc queues a prompt without touching the mouse.
export function QueueDialog({
  controller,
  snapshot,
  workspace,
  folder,
  queue: saved,
  actions,
  onClose,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace;
  folder: string;
  queue: Queue | null;
  actions: QueueActions;
  onClose: () => void;
}) {
  const queue = saved ?? emptyQueue(folder);
  const [draft, setDraft] = useState("");
  const [removed, setRemoved] = useState<{ title: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  const active = queue.items.find(isActive);
  const waiting = queue.items.filter((item) => item.state === "queued");
  const add = (front: boolean) => {
    if (!draft.trim()) return;
    actions.add(folder, draft, front);
    setDraft("");
  };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      // Before the window's shortcuts, which bind ⇧⌘↵ to zoom.
      event.preventDefault();
      add(event.shiftKey);
    }
  };
  const goTo = (item: Item) => {
    if (!item.tabId) return;
    controller.request("tab.focus", { tab_id: item.tabId });
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog queue-dialog"
        role="dialog"
        aria-labelledby="queue-title"
        style={{ "--hue": hueColor(workspace.label) } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Queue</span>
            <h2 id="queue-title">{workspace.label}</h2>
            <p className="worktrees-summary">{headline(active, waiting.length)}</p>
          </div>
          <button
            className="queue-pause"
            aria-pressed={queue.paused !== null}
            onClick={() => actions.pause(folder, queue.paused === null)}
            title={queue.paused ? "Start the next prompt when nothing is at work" : "Start nothing new; what runs carries on"}
          >
            {queue.paused ? <PlayIcon /> : <PauseIcon />}
            {queue.paused ? "Resume" : "Pause"}
          </button>
          <button className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>

        {queue.paused && (
          <div className="queue-paused" role="status">
            <span>
              <b>Paused.</b> {queue.paused.reason}
            </span>
            <button onClick={() => actions.pause(folder, false)}>Resume</button>
          </div>
        )}

        <div className="queue-body">
          {active && (
            <section>
              <h3 className="queue-section">Now</h3>
              <Running
                item={active}
                snapshot={snapshot}
                stopAfter={queue.stopAfter}
                onGo={() => goTo(active)}
                onStopAfter={() => actions.set(folder, { stopAfter: !queue.stopAfter })}
              />
            </section>
          )}

          <section>
            <h3 className="queue-section">Up next</h3>
            {waiting.length === 0 ? (
              <p className="queue-empty">Nothing waiting. Write a prompt below; it starts as soon as nothing else is at work.</p>
            ) : (
              <ol className="queue-list">
                {waiting.map((item, index) => (
                  <Waiting
                    key={item.id}
                    item={item}
                    first={index === 0}
                    last={index === waiting.length - 1}
                    onMove={(delta) => actions.move(folder, item.id, delta)}
                    onEdit={(prompt) => actions.edit(folder, item.id, prompt)}
                    onRemove={() => setRemoved({ title: title(item.prompt), undo: actions.remove(folder, item.id) })}
                  />
                ))}
              </ol>
            )}
          </section>

          {queue.history.length > 0 && (
            <section>
              <h3 className="queue-section">Done</h3>
              <ul className="queue-history">
                {queue.history.slice(0, 8).map((item) => (
                  <Finished key={item.id} item={item} onGo={item.tabId && snapshot.tabs.some((t) => t.tab_id === item.tabId) ? () => goTo(item) : null} />
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="queue-composer">
          {removed && (
            <div className="queue-undo" role="status">
              Removed “{removed.title}”.
              <button
                onClick={() => {
                  removed.undo();
                  setRemoved(null);
                }}
              >
                Undo
              </button>
            </div>
          )}
          <textarea
            autoFocus
            value={draft}
            rows={4}
            placeholder="Write a prompt… (its first line is its title)"
            aria-label="New prompt"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKey}
          />
          <div className="queue-composer-row">
            <label title="Ends each prompt asking the agent to commit, so the next one starts from a clean tree">
              <input
                type="checkbox"
                checked={queue.commitSuffix}
                onChange={(event) => actions.set(folder, { commitSuffix: event.target.checked })}
              />
              Commit when done
            </label>
            <label title="Pause rather than start a prompt while the checkout has uncommitted files">
              <input
                type="checkbox"
                checked={queue.requireClean}
                onChange={(event) => actions.set(folder, { requireClean: event.target.checked })}
              />
              Wait for a clean tree
            </label>
            <span className="spacer" />
            <button className="queue-add-front" disabled={!draft.trim()} onClick={() => add(true)} title="Add before what is waiting (⇧⌘↵)">
              Add first
            </button>
            <button className="queue-add" disabled={!draft.trim()} onClick={() => add(false)}>
              Add <kbd>⌘↵</kbd>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function headline(active: Item | undefined, waiting: number): string {
  const next = waiting === 0 ? "nothing waiting" : `${waiting} waiting`;
  const now = active ? `#${active.n} running · ` : "";
  return `${now}${next} · one at a time, each in a fresh session`;
}

function minutes(since: number | undefined): string {
  if (!since) return "";
  const m = Math.floor((Date.now() - since) / 60_000);
  return m < 1 ? "just started" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Running({
  item,
  snapshot,
  stopAfter,
  onGo,
  onStopAfter,
}: {
  item: Item;
  snapshot: Snapshot;
  stopAfter: boolean;
  onGo: () => void;
  onStopAfter: () => void;
}) {
  const agent = snapshot.agents.find((a) => a.pane_id === item.paneId);
  const words =
    item.state === "starting"
      ? "starting its agent"
      : item.state === "waiting"
        ? "waiting for its agent to be ready"
        : item.state === "prompting"
          ? "sending the prompt"
          : agent?.agent_status === "blocked"
            ? "waiting on you"
            : (agent?.agent_status ?? "running");
  return (
    <div className="queue-item running">
      <div className="queue-item-top">
        {agent && <StatusMark status={agent.agent_status} />}
        <span className="queue-n">#{item.n}</span>
        <span className="queue-title">{title(item.prompt)}</span>
        <span className="queue-when">
          {words} · {minutes(item.started)}
        </span>
      </div>
      <Preview prompt={item.prompt} />
      {item.state === "waiting" && item.reason && <p className="queue-note">{item.reason}. Answer it in the tab; the prompt follows.</p>}
      <div className="worktree-actions">
        <button className="primary" disabled={!item.tabId} onClick={onGo}>
          <TerminalIcon />
          Go to tab
        </button>
        <button aria-pressed={stopAfter} onClick={onStopAfter}>
          <PauseIcon />
          {stopAfter ? "Will pause after this" : "Pause after this"}
        </button>
      </div>
    </div>
  );
}

/// The prompt under its title: two lines, or all of it once clicked.
function Preview({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const rest = prompt.split("\n").filter((line) => line.trim()).slice(1).join("\n");
  if (!rest) return null;
  return (
    <p className={`queue-preview ${open ? "open" : ""}`} onClick={() => setOpen(!open)} title={open ? undefined : "Show all"}>
      {rest}
    </p>
  );
}

function Waiting({
  item,
  first,
  last,
  onMove,
  onEdit,
  onRemove,
}: {
  item: Item;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  onEdit: (prompt: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing !== null) box.current?.focus();
  }, [editing !== null]);
  if (editing !== null) {
    const save = () => {
      onEdit(editing);
      setEditing(null);
    };
    return (
      <li className="queue-item editing">
        <textarea
          ref={box}
          value={editing}
          rows={Math.min(12, Math.max(3, editing.split("\n").length))}
          aria-label={`Edit prompt #${item.n}`}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              save();
            }
            if (event.key === "Escape") {
              // Cancels the edit, not the dialog.
              event.stopPropagation();
              setEditing(null);
            }
          }}
        />
        <div className="queue-edit-row">
          <button onClick={() => setEditing(null)}>Cancel</button>
          <button className="queue-add" disabled={!editing.trim()} onClick={save}>
            Save <kbd>⌘↵</kbd>
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="queue-item">
      <div className="queue-item-top">
        <span className="queue-n">#{item.n}</span>
        <span className="queue-title">{title(item.prompt)}</span>
        <span className="queue-tools">
          <button title="Edit" aria-label={`Edit #${item.n}`} onClick={() => setEditing(item.prompt)}>
            ✎
          </button>
          <button title="Earlier" aria-label={`Move #${item.n} earlier`} disabled={first} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button title="Later" aria-label={`Move #${item.n} later`} disabled={last} onClick={() => onMove(1)}>
            ↓
          </button>
          <button title="Remove" aria-label={`Remove #${item.n}`} onClick={onRemove}>
            ×
          </button>
        </span>
      </div>
      <Preview prompt={item.prompt} />
    </li>
  );
}

function Finished({ item, onGo }: { item: Item; onGo: (() => void) | null }) {
  const ok = item.state === "done";
  const took = item.started && item.finished ? Math.max(1, Math.round((item.finished - item.started) / 60_000)) : null;
  const facts = ok
    ? [
        item.commits !== undefined && `${item.commits} ${item.commits === 1 ? "commit" : "commits"}`,
        took && `${took}m`,
        item.finished && new Date(item.finished).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ]
    : [item.reason];
  return (
    <li className={`queue-done ${ok ? "ok" : "bad"}`} title={item.prompt}>
      <span className="queue-done-mark" aria-label={item.state}>
        {ok ? "✓" : "✕"}
      </span>
      <span className="queue-n">#{item.n}</span>
      <span className="queue-title">{title(item.prompt)}</span>
      <span className="queue-when">{facts.filter(Boolean).join(" · ")}</span>
      {onGo && (
        <button className="link-button" onClick={onGo}>
          tab
        </button>
      )}
    </li>
  );
}

/// What ⌘⇧A shows while attached to another machine: queues start agents
/// through the `herdr` CLI on this Mac, so they run only on its daemon.
export function QueueUnavailable({ onClose }: { onClose: () => void }) {
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog queue-dialog"
        role="dialog"
        aria-label="Queue"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Queue</span>
            <p className="worktrees-summary">Prompt queues run on this Mac's Herdr only. Attach to this Mac to use one.</p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
      </div>
    </div>
  );
}
