import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import { emptyQueue, isActive, type Item, type Queue, title } from "../app/queue";
import type { QueueActions } from "../app/useQueue";
import type { Snapshot, Workspace } from "../protocol";
import { PauseIcon, PlayIcon, TerminalIcon } from "./icons";

/// How long a removed prompt can be brought back.
const UNDO_MS = 6000;

/// The focused workspace's prompt queue in the right-hand drawer, beside
/// Changes and Files. A track runs down it: the prompt running now is its lit
/// node, the waiting ones follow in order, and it ends at the box where the
/// next prompt is written, so adding one extends the line. Finished prompts
/// fold into a row at the foot.
export function QueuePanel({
  controller,
  snapshot,
  workspace,
  folder,
  queue: saved,
  actions,
  focusComposer,
  onClose,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  /// The workspace's folder; null when there is no workspace or it is on another machine.
  folder: string | null;
  queue: Queue | null;
  actions: QueueActions | null;
  /// Put the cursor in the prompt box: when opened by hand, not when it opened on its own.
  focusComposer: boolean;
  onClose: () => void;
}) {
  const head = (
    <header className="changes-head queue-head">
      <span>Queue</span>
      <button className="icon-button" aria-label="Close queue" title="Close (⌘⇧A)" onClick={onClose}>
        ×
      </button>
    </header>
  );
  if (!workspace || !folder || !actions) {
    return (
      <aside className="changes queue-panel" aria-label="Queue">
        {head}
        <p className="empty">
          {actions ? "Focus a workspace to see its queue." : "Queues run on this Mac's Herdr. Attach to this Mac to use one."}
        </p>
      </aside>
    );
  }
  return (
    <QueueBody
      controller={controller}
      snapshot={snapshot}
      workspace={workspace}
      folder={folder}
      queue={saved ?? emptyQueue(folder)}
      actions={actions}
      focusComposer={focusComposer}
      onClose={onClose}
    />
  );
}

function QueueBody({
  controller,
  snapshot,
  workspace,
  folder,
  queue,
  actions,
  focusComposer,
  onClose,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace;
  folder: string;
  queue: Queue;
  actions: QueueActions;
  focusComposer: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [removed, setRemoved] = useState<{ title: string; undo: () => void } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);
  // Opening the panel by hand, or switching workspace with it so open, puts the cursor in the box.
  useEffect(() => {
    if (focusComposer) composer.current?.focus();
  }, [focusComposer, workspace.workspace_id]);

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
    } else if (event.key === "Escape" && !draft) {
      controller.focusTerminal();
    }
  };
  const goTo = (item: Item) => item.tabId && controller.request("tab.focus", { tab_id: item.tabId });

  return (
    <aside className="changes queue-panel" aria-label="Queue" style={{ "--hue": hueColor(workspace.label) } as CSSProperties}>
      <header className="changes-head queue-head">
        <span className="queue-head-title">
          Queue <b title={folder}>{workspace.label}</b>
        </span>
        <button
          className={`icon-button queue-pause-toggle ${queue.paused ? "paused" : ""}`}
          aria-pressed={queue.paused !== null}
          aria-label={queue.paused ? "Resume the queue" : "Pause the queue"}
          title={queue.paused ? "Resume: start the next prompt when nothing is at work" : "Pause: start nothing new; what runs carries on"}
          onClick={() => actions.pause(folder, queue.paused === null)}
        >
          {queue.paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <button className="icon-button" aria-label="Close queue" title="Close (⌘⇧A)" onClick={onClose}>
          ×
        </button>
      </header>

      {queue.paused && (
        <div className="queue-banner" role="status">
          <p>
            <b>Paused.</b> {queue.paused.reason}
          </p>
          <button onClick={() => actions.pause(folder, false)}>
            <PlayIcon />
            Resume
          </button>
        </div>
      )}

      <ol className="queue-track">
        {active && (
          <Running
            item={active}
            snapshot={snapshot}
            stopAfter={queue.stopAfter}
            onGo={() => goTo(active)}
            onStopAfter={() => actions.set(folder, { stopAfter: !queue.stopAfter })}
            onDrop={() => actions.drop(folder, active.id)}
          />
        )}
        {waiting.map((item, index) => (
          <Waiting
            key={item.id}
            item={item}
            next={index === 0 && !active}
            first={index === 0}
            last={index === waiting.length - 1}
            onMove={(delta) => actions.move(folder, item.id, delta)}
            onEdit={(prompt) => actions.edit(folder, item.id, prompt)}
            onRemove={() => setRemoved({ title: title(item.prompt, 40), undo: actions.remove(folder, item.id) })}
          />
        ))}

        <li className="queue-stop queue-compose">
          <span className="queue-node add" aria-hidden="true">
            +
          </span>
          <div className="queue-compose-box">
            {!active && waiting.length === 0 && (
              <p className="queue-hint">
                Write what an agent should do. It starts in a new tab with a fresh Claude session as soon as nothing
                else in <b>{workspace.label}</b> is working, and the next one waits for it to finish.
              </p>
            )}
            <textarea
              ref={composer}
              value={draft}
              rows={draft.split("\n").length > 3 ? 8 : 4}
              placeholder={waiting.length || active ? "Queue another prompt…" : "Fix the flaky login test…"}
              aria-label="New prompt"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKey}
            />
            <div className="queue-compose-row">
              <button className="queue-add" disabled={!draft.trim()} onClick={() => add(false)}>
                Add to queue <kbd>⌘↵</kbd>
              </button>
              <button
                className="queue-add-first"
                disabled={!draft.trim() || waiting.length === 0}
                title="Put it before the prompts already waiting (⇧⌘↵)"
                onClick={() => add(true)}
              >
                Add first
              </button>
            </div>
            <div className="queue-options">
              <label title="Ends each prompt by asking the agent to commit, so the next one starts from a clean tree">
                <input
                  type="checkbox"
                  checked={queue.commitSuffix}
                  onChange={(event) => actions.set(folder, { commitSuffix: event.target.checked })}
                />
                Ask the agent to commit
              </label>
              <label title="Pause instead of starting a prompt while the checkout has uncommitted files">
                <input
                  type="checkbox"
                  checked={queue.requireClean}
                  onChange={(event) => actions.set(folder, { requireClean: event.target.checked })}
                />
                Wait for a clean tree
              </label>
            </div>
          </div>
        </li>
      </ol>

      {removed && (
        <div className="queue-undo" role="status">
          <span>Removed “{removed.title}”</span>
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

      {queue.history.length > 0 && (
        <section className="queue-done-list">
          <button className="queue-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <span className="chevron">›</span>
            {doneSummary(queue.history)}
          </button>
          {showDone && (
            <ul>
              {queue.history.map((item) => (
                <Finished
                  key={item.id}
                  item={item}
                  onGo={item.tabId && snapshot.tabs.some((t) => t.tab_id === item.tabId) ? () => goTo(item) : null}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}

function doneSummary(history: Item[]): string {
  const done = history.filter((item) => item.state === "done").length;
  const failed = history.length - done;
  return [`${done} done`, failed > 0 && `${failed} stopped`].filter(Boolean).join(" · ");
}

function elapsed(since: number | undefined): string {
  if (!since) return "";
  const m = Math.floor((Date.now() - since) / 60_000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Running({
  item,
  snapshot,
  stopAfter,
  onGo,
  onStopAfter,
  onDrop,
}: {
  item: Item;
  snapshot: Snapshot;
  stopAfter: boolean;
  onGo: () => void;
  onStopAfter: () => void;
  onDrop: () => void;
}) {
  const agent = snapshot.agents.find((a) => a.pane_id === item.paneId);
  const blocked = agent?.agent_status === "blocked";
  const words =
    item.state === "starting"
      ? "Starting Claude…"
      : item.state === "waiting"
        ? "Waiting for Claude to be ready"
        : item.state === "prompting"
          ? "Sending the prompt…"
          : blocked
            ? "Waiting on you"
            : agent?.agent_status === "working"
              ? "Working"
              : "Finishing";
  return (
    <li className={`queue-stop running ${blocked || item.state === "waiting" ? "needs-you" : ""}`}>
      <span className="queue-node" aria-hidden="true" />
      <div className="queue-card">
        <div className="queue-card-meta">
          <span className="queue-state">{words}</span>
          <span className="queue-num">
            #{item.n} · {elapsed(item.started)}
          </span>
        </div>
        <p className="queue-card-title" title={item.prompt}>
          {title(item.prompt, 120)}
        </p>
        <FromAgent item={item} />
        {item.state === "waiting" && item.reason && (
          <p className="queue-note" title={item.reason}>Claude is asking something before it starts. Answer it in the tab; the prompt follows.</p>
        )}
        <div className="queue-card-actions">
          <button className="primary" disabled={!item.tabId} onClick={onGo}>
            <TerminalIcon />
            Open tab
          </button>
          <button aria-pressed={stopAfter} onClick={onStopAfter} title="Pause the queue once this prompt finishes">
            <PauseIcon />
            {stopAfter ? "Pausing after" : "Pause after"}
          </button>
          {item.state !== "starting" && item.state !== "prompting" && (
            <button onClick={onDrop} title="Take it off the queue; its tab and agent stay as they are">
              Remove
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function Waiting({
  item,
  next,
  first,
  last,
  onMove,
  onEdit,
  onRemove,
}: {
  item: Item;
  /// The one that starts as soon as the queue may start something.
  next: boolean;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  onEdit: (prompt: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const isEditing = editing !== null;
  useEffect(() => {
    if (isEditing) box.current?.focus();
  }, [isEditing]);
  const save = () => {
    if (editing !== null) onEdit(editing);
    setEditing(null);
  };
  const lines = item.prompt.split("\n").filter((line) => line.trim());
  return (
    <li className={`queue-stop waiting ${isEditing ? "editing" : ""}`}>
      <span className="queue-node" aria-hidden="true" />
      {isEditing ? (
        <div className="queue-edit">
          <textarea
            ref={box}
            value={editing}
            rows={Math.min(14, Math.max(4, editing.split("\n").length + 1))}
            aria-label={`Edit prompt #${item.n}`}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(null);
              }
            }}
          />
          <div className="queue-compose-row">
            <button className="queue-add" disabled={!editing.trim()} onClick={save}>
              Save <kbd>⌘↵</kbd>
            </button>
            <button className="queue-add-first" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="queue-row">
          <button
            className="queue-row-text"
            aria-expanded={lines.length > 1 ? open : undefined}
            title={open ? undefined : item.prompt}
            onClick={() => setOpen(!open)}
            onDoubleClick={() => setEditing(item.prompt)}
          >
            <span className="queue-num">
              #{item.n}
              {next && <em> next</em>}
            </span>
            <span className="queue-row-title">{title(item.prompt, 120)}</span>
            <FromAgent item={item} />
            {open && lines.length > 1 && <span className="queue-row-rest">{lines.slice(1).join("\n")}</span>}
          </button>
          <span className="queue-tools">
            <button title="Edit" aria-label={`Edit #${item.n}`} onClick={() => setEditing(item.prompt)}>
              ✎
            </button>
            <button title="Move up" aria-label={`Move #${item.n} up`} disabled={first} onClick={() => onMove(-1)}>
              ↑
            </button>
            <button title="Move down" aria-label={`Move #${item.n} down`} disabled={last} onClick={() => onMove(1)}>
              ↓
            </button>
            <button className="danger" title="Remove" aria-label={`Remove #${item.n}`} onClick={onRemove}>
              ×
            </button>
          </span>
        </div>
      )}
    </li>
  );
}

/// Marks a prompt that came through the inbox, naming its sender on hover.
function FromAgent({ item }: { item: Item }) {
  if (item.source === undefined) return null;
  return (
    <span className="queue-from" title={item.source || undefined}>
      Queued from an agent
    </span>
  );
}

function Finished({ item, onGo }: { item: Item; onGo: (() => void) | null }) {
  const ok = item.state === "done";
  const took = item.started && item.finished ? Math.max(1, Math.round((item.finished - item.started) / 60_000)) : null;
  const facts = ok
    ? [item.commits !== undefined && `${item.commits} ${item.commits === 1 ? "commit" : "commits"}`, took && `${took}m`]
    : [item.reason];
  return (
    <li className={`queue-finished ${ok ? "ok" : "bad"}`} title={item.prompt}>
      <span className="queue-finished-mark" aria-label={ok ? "done" : item.state}>
        {ok ? "✓" : "!"}
      </span>
      <span className="queue-finished-text">
        <span className="queue-row-title">{title(item.prompt, 80)}</span>
        <span className="queue-finished-facts">{facts.filter(Boolean).join(" · ")}</span>
      </span>
      {onGo && (
        <button className="queue-finished-go" title="Open its tab" aria-label={`Open the tab of #${item.n}`} onClick={onGo}>
          <TerminalIcon />
        </button>
      )}
    </li>
  );
}
