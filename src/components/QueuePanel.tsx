import { openUrl } from "@tauri-apps/plugin-opener";
import { addTask, fillTemplate, parkedTask, projectFor, queuedTask, readComments, type Task, taskUrl, templateFor } from "../app/todoist";
import { agentSuggestions, queuedTaskIds, taskRef } from "../app/todoistTriage";
import { readLibrary } from "../app/promptLibrary";
import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { tildePath } from "../app/folder";
import type { Outcome } from "../app/ledger";
import { formatSpan, relativeTime } from "../app/time";
import { useHome } from "../app/useHome";
import { emptyQueue, inItsTab, isAway, isInLine, type Item, type Queue, queueDirectory, runningState, title, worktreeBranch } from "../app/queue";
import type { QueueAccess, QueueActions } from "../app/useQueue";
import type { Snapshot, Workspace } from "../protocol";
import { AllQueues, type QueueOwner } from "./AllQueues";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { PauseIcon, PlayIcon, TerminalIcon } from "./icons";
import { QueueItemDialog } from "./QueueItemDialog";
import { StatusMark } from "./StatusMark";

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
  hue,
  folder,
  queue: saved,
  access,
  actions,
  parked,
  onParked,
  todoist,
  agentTasks,
  todoistFolders,
  all,
  ownerOf,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  /// The workspace's color.
  hue: string;
  /// The workspace's folder; null when there is no workspace or it is on another machine.
  folder: string | null;
  queue: Queue | null;
  access: QueueAccess;
  actions: QueueActions | null;
  /// What sessions in this checkout left for later (`herdr-outcome left`).
  parked: Outcome[];
  /// Queues a parked note as a prompt, dismisses it, or marks it sent to Todoist.
  onParked: (outcome: Outcome, how: ParkedHow) => void;
  /// `todoist.projects`, project names to folders; null when Todoist has no token.
  todoist: Record<string, string> | null;
  /// Todoist's `@agent` tasks, suggested as prompts; null when not read.
  agentTasks: Task[] | null;
  /// The open workspaces' repo folders, which `@repo:` labels can name.
  todoistFolders: string[];
  /// Every queue with something in it, for the All view.
  all: Queue[];
  ownerOf: (folder: string) => QueueOwner | null;
}) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const [showAll, setShowAll] = useState(false);
  // Only a hand opening the panel moves the cursor. The body below remounts
  // whenever the folder goes unknown, as on a `cd` in a lone shell, and the
  // workspace can change without a key pressed: neither may take the keyboard.
  useEffect(() => {
    if (!controller.composerAsked) return;
    controller.composerAsked = false;
    composer.current?.focus();
  });
  const head = (
    <header className="changes-head queue-head">
      <span>Queue</span>
    </header>
  );
  // Without the queue file there is nothing to show and nowhere to add to, so
  // the panel says so rather than look like an empty queue.
  if (access.kind !== "ready") {
    return (
      <aside className="changes queue-panel" aria-label="Queue">
        {head}
        {access.kind === "loading" ? (
          <p className="empty">Loading the queue…</p>
        ) : (
          <div className="queue-off" role="status">
            <p>
              <b>No queue in this window.</b>
            </p>
            <p>{access.reason}</p>
          </div>
        )}
      </aside>
    );
  }
  const scope = (
    <span className="queue-scope" role="group" aria-label="Which queues">
      <button aria-pressed={!showAll} disabled={!workspace} onClick={() => setShowAll(false)}>
        This workspace
      </button>
      <button aria-pressed={showAll} onClick={() => setShowAll(true)}>
        All{all.length > 0 && ` ${all.length}`}
      </button>
    </span>
  );
  if (actions && (showAll || !workspace)) {
    return (
      <aside className="changes queue-panel" aria-label="Queue">
        <header className="changes-head queue-head">
          <span className="queue-head-title">
            Queue <b>every workspace</b>
          </span>
        </header>
        <div className="queue-scope-row">{scope}</div>
        <AllQueues
          queues={all}
          ownerOf={ownerOf}
          actions={actions}
          onOpen={(workspaceId) => {
            setShowAll(false);
            controller.request("workspace.focus", { workspace_id: workspaceId });
          }}
          onGo={(tabId) => controller.request("tab.focus", { tab_id: tabId })}
        />
      </aside>
    );
  }
  if (!workspace || !folder || !actions) {
    return (
      <aside className="changes queue-panel" aria-label="Queue">
        {head}
        <p className="empty">
          {actions ? "Focus a workspace to see its queue." : "Queues run on this computer's Herdr. Attach to this computer to use one."}
        </p>
      </aside>
    );
  }
  return (
    <QueueBody
      controller={controller}
      snapshot={snapshot}
      workspace={workspace}
      hue={hue}
      folder={folder}
      queue={saved ?? emptyQueue(folder)}
      separate={access.separate}
      actions={actions}
      composer={composer}
      parked={parked}
      onParked={onParked}
      todoist={todoist}
      agentTasks={agentTasks}
      todoistFolders={todoistFolders}
      all={all}
      scope={scope}
    />
  );
}

function QueueBody({
  controller,
  snapshot,
  workspace,
  hue,
  folder,
  queue,
  separate,
  actions,
  composer,
  parked,
  onParked,
  todoist,
  agentTasks,
  todoistFolders,
  all,
  scope,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace;
  hue: string;
  folder: string;
  queue: Queue;
  /// A dev build's own queue, apart from the daily window's.
  separate: boolean;
  actions: QueueActions;
  composer: RefObject<HTMLTextAreaElement | null>;
  parked: Outcome[];
  onParked: (outcome: Outcome, how: ParkedHow) => void;
  todoist: Record<string, string> | null;
  agentTasks: Task[] | null;
  todoistFolders: string[];
  all: Queue[];
  /// The This workspace / All switch.
  scope: ReactNode;
}) {
  const home = useHome();
  const directory = queueDirectory(folder);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const active = queue.items.find(isInLine);
  const away = queue.items.filter(isAway);
  const waiting = queue.items.filter((item) => item.state === "queued");
  const add = (front: boolean) => {
    if (!draft.trim()) return;
    actions.add(folder, draft, front);
    setDraft("");
  };
  const help = `Each prompt starts in a new tab with a fresh Claude session as soon as nothing else in ${workspace.label} is working, and the next one waits for it to finish.`;
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
  const hasTab = (item: Item) => snapshot.tabs.some((tab) => tab.tab_id === item.tabId);
  // By id, so it follows the file: gone with another workspace or an old item.
  const opened = queue.history.find((item) => item.id === openId);
  // Where a task from here goes: the project mapped to this folder, else the Inbox.
  const project = todoist && projectFor(directory, todoist, home);
  const toTodoist = (outcome: Outcome) =>
    addTask(parkedTask(outcome, home), project ?? null).then((task) => {
      onParked(outcome, "todo");
      setNotice(sentNotice(task));
    });
  // `@agent` tasks for this repo not queued anywhere yet: offered, never added by themselves.
  const suggested =
    todoist && agentTasks
      ? agentSuggestions(agentTasks, queuedTaskIds([queue, ...all]), directory, todoist, home, todoistFolders)
      : [];
  // One click adds one: the template the Todoist panel would pick, filled with the task and its comments.
  const queueTask = async (task: Task) => {
    const [library, comments] = await Promise.all([
      readLibrary(directory).catch(() => null),
      readComments(task.id).catch(() => []),
    ]);
    const template = library ? templateFor(task, library.prompts) : null;
    actions.add(folder, fillTemplate(template?.body ?? null, task, comments), false, taskRef(task));
  };
  // The task first: the prompt leaves the queue only once Todoist holds it.
  const remind = (item: Item, due: string) =>
    addTask(queuedTask(item.prompt, directory, due, home), project ?? null).then((task) => {
      actions.remove(folder, item.id);
      setNotice(sentNotice(task));
    });

  return (
    <aside className="changes queue-panel" aria-label="Queue" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">
        <span className="queue-head-title">
          Queue <b title={directory}>{workspace.label}</b>
          <span className="queue-head-folder" title="This workspace's queue is kept for this folder, whichever tab is focused">
            {tildePath(directory, home)}
          </span>
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
      </header>
      <div className="queue-scope-row">{scope}</div>

      {separate && (
        <div className="queue-banner" role="status">
          <p>
            <b>Test queue.</b> This dev build keeps a queue of its own. Your daily window's queue is not shown here
            and is left alone.
          </p>
        </div>
      )}

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

      {parked.length > 0 && (
        <Parked controller={controller} parked={parked} onParked={onParked} onTodoist={todoist ? toTodoist : null} />
      )}

      {suggested.length > 0 && <Suggested controller={controller} tasks={suggested} onQueue={queueTask} />}

      <ol className="queue-track">
        {active && (
          <Running
            item={active}
            snapshot={snapshot}
            onGo={() => goTo(active)}
            onDrop={() => actions.drop(folder, active.id)}
          />
        )}
        {away.map((item) => (
          <Running
            key={item.id}
            item={item}
            snapshot={snapshot}
            onGo={() => goTo(item)}
            onDrop={() => actions.drop(folder, item.id)}
          />
        ))}
        {waiting.map((item, index) => (
          <Waiting
            key={item.id}
            item={item}
            next={index === 0 && !active}
            first={index === 0}
            last={index === waiting.length - 1}
            onMove={(delta) => actions.move(folder, item.id, delta)}
            onWorktree={() => actions.runInWorktree(folder, item.id)}
            onEdit={(prompt) => actions.edit(folder, item.id, prompt)}
            onRemove={() => {
              const undo = actions.remove(folder, item.id);
              setNotice({ text: `Removed “${title(item.prompt, 40)}”`, button: "Undo", onClick: undo });
            }}
            onRemind={
              todoist
                ? (due) => {
                    const sent = remind(item, due);
                    controller.act(sent);
                    return sent;
                  }
                : null
            }
          />
        ))}

        <li className="queue-compose">
          <div className="queue-compose-box">
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
              <span className="queue-help" role="img" aria-label={help} title={help}>
                ?
              </span>
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

      {notice && (
        <div className="queue-undo" role="status">
          <span>{notice.text}</span>
          <button
            onClick={() => {
              notice.onClick();
              setNotice(null);
            }}
          >
            {notice.button}
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
                  onOpen={() => setOpenId(item.id)}
                  onGo={hasTab(item) ? () => goTo(item) : null}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {opened && (
        <QueueItemDialog
          item={opened}
          folder={directory}
          hue={hue}
          onGo={
            hasTab(opened)
              ? () => {
                  setOpenId(null);
                  goTo(opened);
                }
              : null
          }
          onClose={() => setOpenId(null)}
        />
      )}
    </aside>
  );
}

type ParkedHow = "queued" | "dismissed" | "todo";

/// What the line under the queue says for a while, with one button.
interface Notice {
  text: string;
  button: string;
  onClick: () => void;
}

const sentNotice = (task: Task): Notice => ({
  text: `Sent “${title(task.title, 40)}” to ${task.project ?? "Todoist"}${task.due_words ? `, due ${task.due_words}` : ""}`,
  button: "Open ↗",
  onClick: () => void openUrl(task.url),
});

/// Notes sessions here left for later, not yet prompts: Queue it writes one
/// that stands on its own and puts it at the end of the line; To Todoist makes
/// it a task there instead.
function Parked({
  controller,
  parked,
  onParked,
  onTodoist,
}: {
  controller: Controller;
  parked: Outcome[];
  onParked: (outcome: Outcome, how: ParkedHow) => void;
  /// Null without a Todoist token.
  onTodoist: ((outcome: Outcome) => Promise<void>) | null;
}) {
  const [open, setOpen] = useState(true);
  // The note on its way, so a second click sends no second task.
  const [sending, setSending] = useState<string | null>(null);
  return (
    <section className="queue-parked">
      <button
        className="queue-done-toggle queue-parked-toggle"
        aria-expanded={open}
        title="What sessions in this checkout left for later (herdr-outcome left)"
        onClick={() => setOpen(!open)}
      >
        <span className="chevron">›</span>
        {parked.length} parked
      </button>
      {open && (
        <ul>
          {parked.map((outcome) => (
            <li key={outcome.id} className="queue-parked-item">
              <p className="queue-parked-note" title={outcome.note}>
                {outcome.note}
              </p>
              <div className="queue-parked-row">
                <span className="queue-parked-meta" title={outcome.cwd}>
                  {[outcome.branch, relativeTime(outcome.time / 1000)].filter(Boolean).join(" · ")}
                </span>
                <button title="Add it to the end of this queue as a prompt" onClick={() => onParked(outcome, "queued")}>
                  Queue it
                </button>
                {onTodoist && (
                  <button
                    title="Make it a Todoist task, with its repo and branch, and take it off this list"
                    disabled={sending !== null}
                    onClick={() => {
                      setSending(outcome.id);
                      controller.act(onTodoist(outcome).finally(() => setSending(null)));
                    }}
                  >
                    {sending === outcome.id ? "Sending…" : "To Todoist"}
                  </button>
                )}
                <button className="queue-parked-dismiss" title="Nothing to do about it" onClick={() => onParked(outcome, "dismissed")}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/// Todoist tasks labelled `@agent`, offered as prompts: one click adds one to
/// the end of the queue, filled with its template. Nothing else adds them.
function Suggested({ controller, tasks, onQueue }: { controller: Controller; tasks: Task[]; onQueue: (task: Task) => Promise<void> }) {
  const [open, setOpen] = useState(true);
  // The task on its way, so a second click adds no second prompt.
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <section className="queue-parked queue-suggested">
      <button
        className="queue-done-toggle queue-parked-toggle"
        aria-expanded={open}
        title="Todoist tasks labelled @agent, for this repo or for none, not queued yet"
        onClick={() => setOpen(!open)}
      >
        <span className="chevron">›</span>
        {tasks.length} from Todoist @agent
      </button>
      {open && (
        <ul>
          {tasks.map((task) => (
            <li key={task.id} className="queue-parked-item">
              <p className="queue-parked-note" title={task.description || task.title}>
                ☐ {task.title}
              </p>
              <div className="queue-parked-row">
                <span className="queue-parked-meta">{[task.project, task.due_words].filter(Boolean).join(" · ")}</span>
                <button
                  title="Add it to the end of this queue, filled with its template. It waits its turn."
                  disabled={adding !== null}
                  onClick={() => {
                    setAdding(task.id);
                    controller.act(onQueue(task).finally(() => setAdding(null)));
                  }}
                >
                  {adding === task.id ? "Adding…" : "Queue it"}
                </button>
                <button className="queue-parked-dismiss" title={`Open in Todoist: ${task.url}`} onClick={() => controller.act(openUrl(task.url))}>
                  ↗
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function doneSummary(history: Item[]): string {
  const done = history.filter((item) => item.state === "done").length;
  const failed = history.length - done;
  return [`${done} done`, failed > 0 && `${failed} stopped`].filter(Boolean).join(" · ");
}

function elapsed(since: number | undefined): string {
  return since ? formatSpan(Date.now() - since) : "";
}

function Running({
  item,
  snapshot,
  onGo,
  onDrop,
}: {
  item: Item;
  snapshot: Snapshot;
  onGo: () => void;
  onDrop: () => void;
}) {
  const agent = snapshot.agents.find((a) => a.pane_id === item.paneId);
  const { words, mark } = runningState(item, agent?.agent_status);
  const here = inItsTab(item, snapshot.focused_tab_id);
  const canOpen = !!item.tabId && !here;
  const canLeave = item.state !== "starting" && item.state !== "prompting";
  return (
    <li className={`queue-stop running ${mark === "blocked" ? "needs-you" : ""}`}>
      <span className={`queue-node ${mark ? "marked" : ""}`} aria-hidden="true">
        {mark && <StatusMark status={mark} />}
      </span>
      <div
        className={`queue-card ${canOpen ? "opens" : ""}`}
        title={canOpen ? "Open its tab" : undefined}
        onClick={canOpen ? onGo : undefined}
      >
        <div className="queue-card-meta">
          <span className="queue-state">{words}</span>
          <span className="queue-num">
            #{item.n} · {elapsed(item.started)}
          </span>
        </div>
        {/* The keyboard's way in: a click here bubbles to the card. */}
        <button className="queue-card-open" title={item.prompt} disabled={!canOpen} aria-label={`Open the tab of #${item.n}`}>
          <span className="queue-card-title">{title(item.prompt, 120)}</span>
        </button>
        <FromAgent item={item} />
        {item.worktree && (
          <span className="queue-from" title={item.worktree}>
            ⑂ {worktreeBranch(item.worktree)}
          </span>
        )}
        {item.state === "waiting" && item.reason && (
          <p className="queue-note" title={item.reason}>Claude is asking something before it starts. Answer it in the tab; the prompt follows.</p>
        )}
        {(here || canLeave) && (
          <div className="queue-card-actions">
            {here && (
              <span className="queue-here" title="The tab in front is running this prompt">
                <TerminalIcon />
                In this tab
              </span>
            )}
            {canLeave && (
              <button
                className="queue-leave"
                title="Its agent and tab are left untouched; only the queue stops following it. The next prompt waits until the agent is quiet."
                onClick={(event) => {
                  event.stopPropagation();
                  onDrop();
                }}
              >
                Leave queue, keep running
              </button>
            )}
          </div>
        )}
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
  onWorktree,
  onEdit,
  onRemove,
  onRemind,
}: {
  item: Item;
  /// The one that starts as soon as the queue may start something.
  next: boolean;
  first: boolean;
  last: boolean;
  onMove: (delta: number) => void;
  onWorktree: () => void;
  onEdit: (prompt: string) => void;
  onRemove: () => void;
  /// Makes it a Todoist task due `due` and takes it off the queue; null without a token.
  onRemind: ((due: string) => Promise<void>) | null;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [reminding, setReminding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
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
        <div
          className="queue-row"
          onContextMenu={(event) => {
            event.preventDefault();
            const items = [{ label: "Run in a Worktree Now", icon: "⑂", onSelect: onWorktree }];
            setMenu({ x: event.clientX, y: event.clientY, items });
          }}
        >
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
            <FromTask item={item} />
            {open && lines.length > 1 && <span className="queue-row-rest">{lines.slice(1).join("\n")}</span>}
          </button>
          <span className="queue-tools">
            {item.todoist && (
              <button
                title={`Open the Todoist task: ${taskUrl(item.todoist.id)}`}
                aria-label={`Open the Todoist task of #${item.n}`}
                onClick={() => item.todoist && void openUrl(taskUrl(item.todoist.id))}
              >
                ↗
              </button>
            )}
            {onRemind && (
              <button
                title="Remind in Todoist: a dated task holding this prompt, taken off the queue"
                aria-label={`Remind #${item.n} in Todoist`}
                aria-expanded={reminding !== null}
                onClick={() => setReminding(reminding === null ? "tomorrow" : null)}
              >
                ☐
              </button>
            )}
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
          {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        </div>
      )}
      {onRemind && reminding !== null && (
        <Remind
          n={item.n}
          due={reminding}
          onDue={setReminding}
          onSend={() => onRemind(reminding).then(() => setReminding(null))}
          onCancel={() => setReminding(null)}
        />
      )}
    </li>
  );
}

/// The due date for a reminder, in Todoist's own words, and the button that sends it.
function Remind({
  n,
  due,
  onDue,
  onSend,
  onCancel,
}: {
  n: number;
  due: string;
  onDue: (due: string) => void;
  onSend: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const send = () => {
    if (!due.trim() || busy) return;
    setBusy(true);
    // A refusal keeps the field, to fix the date; the caller says why.
    onSend().catch(() => setBusy(false));
  };
  return (
    <div className="queue-remind">
      <input
        type="text"
        value={due}
        // Focused as it opens, as a click on ☐ asked for it.
        autoFocus
        spellCheck={false}
        disabled={busy}
        placeholder="tomorrow 9am"
        aria-label={`When Todoist should remind you of #${n}`}
        title="Todoist reads it: tomorrow 9am, next monday, in 3 days, Dec 1"
        onChange={(event) => onDue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") send();
          else if (event.key === "Escape") onCancel();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      <button className="queue-add" disabled={!due.trim() || busy} onClick={send}>
        {busy ? "Sending…" : "Remind"}
      </button>
      <button className="queue-add-first" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
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

/// Names the Todoist task a prompt was sent from; its link is among the row's tools.
function FromTask({ item }: { item: Item }) {
  if (!item.todoist) return null;
  return (
    <span className="queue-from queue-task" title={taskUrl(item.todoist.id)}>
      ☐ {item.todoist.title}
    </span>
  );
}

function Finished({ item, onOpen, onGo }: { item: Item; onOpen: () => void; onGo: (() => void) | null }) {
  const ok = item.state === "done";
  const took = item.started && item.finished ? formatSpan(item.finished - item.started) : null;
  const facts = ok
    ? [item.commits !== undefined && `${item.commits} ${item.commits === 1 ? "commit" : "commits"}`, took]
    : [item.reason];
  return (
    <li className={`queue-finished ${ok ? "ok" : "bad"}`} title={item.prompt}>
      <span className="queue-finished-mark" aria-label={ok ? "done" : item.state}>
        {ok ? "✓" : "!"}
      </span>
      <button className="queue-finished-text" onClick={onOpen}>
        <span className="queue-row-title">{title(item.prompt, 80)}</span>
        <span className="queue-finished-facts">{facts.filter(Boolean).join(" · ")}</span>
      </button>
      {onGo && (
        <button className="queue-finished-go" title="Open its tab" aria-label={`Open the tab of #${item.n}`} onClick={onGo}>
          <TerminalIcon />
        </button>
      )}
    </li>
  );
}
