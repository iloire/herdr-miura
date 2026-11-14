import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { Controller } from "../app/controller";
import { type Action, ACTIONS, type Prompt, readLibrary, sendPrompt, startInNewTab } from "../app/promptLibrary";
import {
  addTask,
  type Comment,
  commentsBlock,
  fillTemplate,
  isMapped,
  localDay,
  matchingTasks,
  overdue,
  projectFor,
  readComments,
  sendTarget,
  setDone,
  sortTasks,
  type Target,
  type Task,
  taskRepo,
  tasksFor,
  templateFor,
} from "../app/todoist";
import { linkTask } from "../app/todoistLinks";
import {
  acceptedLabels,
  askTriage,
  batchPrompt,
  parseSuggestions,
  repoName,
  setLabels,
  type Suggestion,
  TRIAGE_MAX,
  taskRef,
  triagePrompt,
  triageRepos,
} from "../app/todoistTriage";
import type { QueueActions } from "../app/useQueue";
import type { TodoistTasks } from "../app/useTodoistTasks";
import type { Snapshot, Workspace } from "../protocol";
import { RefreshIcon } from "./icons";

const LABELS: Record<Action, string> = { here: "Send to agent", "new-tab": "New tab", queue: "Queue" };

/// Todoist's priority colors, urgent first; normal has no mark.
const PRIORITY: Record<number, string> = { 4: "p1", 3: "p2", 2: "p3" };

/// The tasks the `todoist.filter` setting matches, in the right-hand drawer:
/// only the focused workspace's when `todoist.projects` maps its folder, with a
/// switch to all of them. Clicking one opens it as a prompt: a library template filled with the task,
/// editable, then sent to the focused agent, a fresh Claude in a new tab, or
/// the workspace's queue, as the prompt library sends.
export function TodoistPanel({
  controller,
  snapshot,
  workspace,
  hue,
  filter,
  tasks,
  projects,
  home,
  targets,
  folder,
  queueFolder,
  queue,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  hue: string;
  filter: string;
  /// The tasks `filter` matches, read by `App` for the status bar too.
  tasks: TodoistTasks;
  /// `todoist.projects`: project names to repo folders.
  projects: Record<string, string>;
  home: string | null;
  /// The open workspaces a task can be sent to, by repo.
  targets: Target[];
  /// The focused workspace's folder on this computer, for project templates and a new tab.
  folder: string | null;
  queueFolder: string | null;
  /// The queue's actions, null when this window does not own the queue.
  queue: QueueActions | null;
}) {
  const { read, failed, refresh } = tasks;
  const [query, setQuery] = useState("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [open, setOpen] = useState<Task | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Tasks ticked to queue together, by id.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Tasks completed here, hidden at once: `closing` while Todoist is asked,
  // `closed` until the next read (a recurring one comes back on its next date).
  const [completed, setCompleted] = useState<ReadonlyMap<string, "closing" | "closed">>(new Map());
  // The last one completed, for Undo.
  const [undoable, setUndoable] = useState<Task | null>(null);
  useEffect(() => {
    setCompleted((current) => {
      const next = new Map([...current].filter(([, state]) => state === "closing"));
      return next.size === current.size ? current : next;
    });
  }, [read]);
  const mark = (id: string, state: "closing" | "closed" | null) =>
    setCompleted((current) => {
      const next = new Map(current);
      if (state) next.set(id, state);
      else next.delete(id);
      return next;
    });
  const complete = (task: Task) => {
    mark(task.id, "closing");
    setUndoable(null);
    controller.act(
      setDone(task.id, true)
        .then(() => {
          mark(task.id, "closed");
          setUndoable(task);
          refresh();
        })
        .catch((error) => {
          mark(task.id, null);
          throw error;
        }),
    );
  };
  const undo = (task: Task) => {
    setUndoable(null);
    controller.act(setDone(task.id, false).then(refresh));
  };

  useEffect(() => {
    let live = true;
    readLibrary(folder)
      .then((library) => live && setPrompts(library.prompts))
      .catch(() => live && setPrompts([]));
    return () => {
      live = false;
    };
  }, [folder]);

  const today = localDay();
  const mapped = isMapped(folder, projects, home);
  const folders = useMemo(() => targets.map((target) => target.folder), [targets]);
  const scoped = useMemo(() => {
    const tasks = (read?.tasks ?? []).filter((task) => !completed.has(task.id));
    return mapped && !showAll && folder ? tasksFor(tasks, folder, projects, home, folders) : tasks;
  }, [read, completed, mapped, showAll, folder, projects, home, folders]);
  const shown = useMemo(() => sortTasks(matchingTasks(scoped, query)), [scoped, query]);
  // Ticked tasks still listed, in list order.
  const picked = useMemo(() => (read?.tasks ?? []).filter((task) => selected.has(task.id)), [read, selected]);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // The queue a task goes to: its own repo's open workspace's, else this one's.
  const queueOf = (task: Task) => sendTarget(taskRepo(task, projects, home, folders), folder, targets)?.queueFolder ?? queueFolder;
  const queueBatch = async (each: boolean) => {
    if (!queue || picked.length === 0) return;
    if (each) {
      const comments = await Promise.all(picked.map((task) => readComments(task.id).catch(() => [])));
      picked.forEach((task, index) => {
        const into = queueOf(task);
        const body = templateFor(task, prompts)?.body ?? null;
        if (into) queue.add(into, fillTemplate(body, task, comments[index]), false, taskRef(task));
      });
    } else {
      // Their shared repo's queue when they all have one, else this workspace's.
      const into = new Set(picked.map(queueOf));
      const only = into.size === 1 ? [...into][0] : queueFolder;
      if (only) queue.add(only, batchPrompt(picked), false, picked.map(taskRef));
    }
    setSelected(new Set());
    controller.openQueue();
  };

  const head = (
    <>
      <span className="queue-head-title" title={`Todoist filter: ${filter}`}>
        Todoist <b>{filter}</b>
      </span>
      {!tasks.off && (
        <button
          type="button"
          className={`icon-button todoist-refresh ${tasks.reading ? "reading" : ""}`}
          aria-label="Refresh tasks"
          title="Read the tasks from Todoist again (it does every minute while this panel is open)"
          disabled={tasks.reading}
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
      )}
    </>
  );
  const scope = mapped && (
    <span className="queue-scope" role="group" aria-label="Which tasks">
      <button aria-pressed={!showAll} onClick={() => setShowAll(false)} title="The tasks todoist.projects or a @repo: label sends to this workspace's repo">
        This repo
      </button>
      <button aria-pressed={showAll} onClick={() => setShowAll(true)} title="Every task the filter matches">
        All
      </button>
    </span>
  );

  if (open) {
    return (
      <aside className="changes sessions-panel todoist-panel" aria-label="Todoist" style={{ "--hue": hue } as CSSProperties}>
        <header className="changes-head queue-head">{head}</header>
        <TaskPrompt
          key={open.id}
          controller={controller}
          snapshot={snapshot}
          task={open}
          prompts={prompts}
          target={sendTarget(taskRepo(open, projects, home, folders), folder, targets)}
          folder={folder}
          workspace={workspace}
          queueFolder={queueFolder}
          queue={queue}
          onBack={() => setOpen(null)}
          onComplete={() => {
            complete(open);
            setOpen(null);
          }}
        />
      </aside>
    );
  }

  return (
    <aside className="changes sessions-panel todoist-panel" aria-label="Todoist" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {scope && <div className="queue-scope-row">{scope}</div>}
      {failed && <div className="queue-banner" role="status">{failed}</div>}
      {!tasks.off && <QuickAdd controller={controller} project={projectFor(folder, projects, home)} onAdded={refresh} />}
      {read && read.tasks.length > 0 && (
        <div className="files-filter">
          <input
            type="search"
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && shown[0]) setOpen(shown[0]);
              else if (event.key === "Escape") {
                if (query) setQuery("");
                else controller.focusTerminal();
              } else return;
              event.preventDefault();
            }}
          />
        </div>
      )}
      {!read && !failed && <p className="empty">Reading Todoist…</p>}
      {read?.tasks.length === 0 && (
        <div className="queue-off">
          <p>
            No tasks match <b>{filter}</b>. The filter is in Settings.
          </p>
        </div>
      )}
      {read && read.tasks.length > 0 && scoped.length === 0 && (
        <div className="queue-off">
          <p>
            None of the {read.tasks.length} tasks is for this repo. <button className="todoist-show-all" onClick={() => setShowAll(true)}>Show all</button>
          </p>
        </div>
      )}
      {undoable && (
        <div className="todoist-done-bar" role="status">
          <span title={undoable.title}>Completed “{undoable.title}”</span>
          <button type="button" title="Reopen it in Todoist" onClick={() => undo(undoable)}>
            Undo
          </button>
        </div>
      )}
      {scoped.length > 0 && shown.length === 0 && <p className="empty">No task holds “{query.trim()}”.</p>}
      {picked.length > 0 && (
        <div className="todoist-batch" role="group" aria-label="Ticked tasks">
          <span>{picked.length} ticked</span>
          <button
            type="button"
            disabled={!queue}
            title={queue ? "One prompt holding every ticked task, one block each, to run as one batch" : "Another window has the queue."}
            onClick={() => controller.act(queueBatch(false))}
          >
            Queue as one
          </button>
          <button
            type="button"
            disabled={!queue}
            title={queue ? "A prompt per task, each filled with its template, in its own repo's queue" : "Another window has the queue."}
            onClick={() => controller.act(queueBatch(true))}
          >
            One each
          </button>
          <button type="button" className="todoist-batch-clear" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <Triage
          controller={controller}
          tasks={shown}
          prompts={prompts}
          repos={triageRepos(projects, home, folders)}
          routed={(task) => {
            const repo = taskRepo(task, projects, home, folders);
            return repo === null ? null : repoName(repo);
          }}
          onChanged={refresh}
        />
      )}
      <div className="sessions-list">
        <ul className="todoist-list">
          {shown.map((task) => (
            <li key={task.id} className="todoist-item">
              <input
                type="checkbox"
                className="todoist-tick"
                aria-label={`Tick “${task.title}” to queue with others`}
                title="Tick several to queue them as one prompt or one each"
                checked={selected.has(task.id)}
                onChange={() => toggle(task.id)}
              />
              <button className="session-row todoist-row" title={task.description || task.title} onClick={() => setOpen(task)}>
                <span className="session-title">
                  {PRIORITY[task.priority] && <span className={`todoist-priority ${PRIORITY[task.priority]}`} aria-label={`priority ${5 - task.priority}`} />}
                  {task.title}
                </span>
                {task.description.trim() && <span className="session-prompt">{task.description.trim()}</span>}
                <span className="session-meta">
                  {task.due_words && <span className={overdue(task, today) ? "todoist-overdue" : undefined}>{task.due_words}</span>}
                  {task.project && <span>{task.project}</span>}
                  {task.labels.map((label) => (
                    <span key={label} className="todoist-label">
                      @{label}
                    </span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                className="todoist-complete"
                aria-label={`Complete “${task.title}”`}
                title="Complete in Todoist"
                onClick={() => complete(task)}
              />
            </li>
          ))}
        </ul>
        {read?.truncated && <p className="empty">Only the first {read.tasks.length} tasks are listed.</p>}
      </div>
    </aside>
  );
}

interface Proposal {
  task: Task;
  suggestion: Suggestion;
  /// The task's labels once accepted.
  labels: string[];
}

/// Suggest: a cheap Claude (Haiku, no tools) reads the listed tasks and
/// proposes a repo and a template for each. Each proposal is accepted (its
/// labels are set in Todoist: `@repo:<name>` and the template's name) or
/// refused; nothing changes until accepted.
function Triage({
  controller,
  tasks,
  prompts,
  repos,
  routed,
  onChanged,
}: {
  controller: Controller;
  tasks: Task[];
  prompts: Prompt[];
  repos: string[];
  /// The repo a task goes to now, by name.
  routed: (task: Task) => string | null;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const asked = tasks.slice(0, TRIAGE_MAX);
  const usable = prompts.filter((prompt) => !prompt.broken);
  const names = [...new Set(usable.map((prompt) => prompt.name))];

  const suggest = () => {
    setAsking(true);
    setFailed(null);
    const templates = names.map((name) => ({ name, description: usable.find((prompt) => prompt.name === name)?.description ?? null }));
    askTriage(triagePrompt(asked, repos, templates))
      .then((answer) => {
        const found = parseSuggestions(answer, asked, repos, names).flatMap((suggestion) => {
          const task = asked.find((entry) => entry.id === suggestion.task);
          const labels = task && acceptedLabels(task, suggestion, names, routed(task));
          return task && labels ? [{ task, suggestion, labels }] : [];
        });
        setProposals(found);
      })
      .catch((error) => setFailed(String(error)))
      .finally(() => setAsking(false));
  };
  const drop = (id: string) => setProposals((current) => current?.filter((entry) => entry.task.id !== id) ?? null);
  const accept = (proposal: Proposal) => {
    setWriting(proposal.task.id);
    controller.act(
      setLabels(proposal.task.id, proposal.labels)
        .then(() => {
          drop(proposal.task.id);
          onChanged();
        })
        .finally(() => setWriting(null)),
    );
  };

  return (
    <section className="todoist-triage" aria-label="Suggestions">
      <div className="todoist-triage-head">
        <button
          type="button"
          disabled={asking}
          title={`A cheap Claude (Haiku, no tools) suggests a repo and a template for the ${asked.length} listed tasks${tasks.length > asked.length ? ` (the first ${TRIAGE_MAX})` : ""}. Nothing changes until you accept.`}
          onClick={suggest}
        >
          {asking ? "Suggesting…" : "Suggest repo and template"}
        </button>
        {proposals !== null && (
          <button type="button" className="todoist-batch-clear" onClick={() => setProposals(null)}>
            Close
          </button>
        )}
      </div>
      {failed && <p className="empty">Suggest failed: {failed}</p>}
      {proposals?.length === 0 && <p className="empty">Nothing to suggest: each task has its repo and template, or the model was unsure.</p>}
      {proposals && proposals.length > 0 && (
        <ul>
          {proposals.map((proposal) => (
            <li key={proposal.task.id} className="todoist-proposal">
              <p className="todoist-proposal-title" title={proposal.task.title}>
                {proposal.task.title}
              </p>
              <p className="todoist-proposal-what">
                {proposal.suggestion.repo && <span>@repo:{proposal.suggestion.repo}</span>}
                {proposal.suggestion.template && <span>/{proposal.suggestion.template}</span>}
                {proposal.suggestion.why && <em>{proposal.suggestion.why}</em>}
              </p>
              <div className="todoist-proposal-row">
                <button
                  type="button"
                  disabled={writing !== null}
                  title={`Set the task's labels in Todoist to ${proposal.labels.map((label) => `@${label}`).join(" ")}`}
                  onClick={() => accept(proposal)}
                >
                  {writing === proposal.task.id ? "Accepting…" : "Accept"}
                </button>
                <button type="button" className="todoist-batch-clear" onClick={() => drop(proposal.task.id)}>
                  Refuse
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/// A box that adds a task to Todoist: to the project mapped to this
/// workspace's repo, else the Inbox. Says where it went, with a link.
function QuickAdd({ controller, project, onAdded }: { controller: Controller; project: string | null; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Task | null>(null);
  const where = project ?? "Inbox";
  const add = () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    addTask({ title: text }, project)
      .then((task) => {
        setTitle("");
        setAdded(task);
        onAdded();
      })
      .catch((error) => controller.act(Promise.reject(error)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="files-filter todoist-add">
      <input
        type="text"
        placeholder={`Add a task to ${where}`}
        aria-label={`Add a Todoist task to ${where}`}
        spellCheck={false}
        disabled={busy}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
          else if (event.key === "Escape" && title) setTitle("");
          else return;
          event.preventDefault();
        }}
      />
      {added && (
        <button type="button" className="todoist-added" title={added.url} onClick={() => controller.act(openUrl(added.url))}>
          Added “{added.title}” to {added.project ?? where} ↗
        </button>
      )}
    </div>
  );
}

/// One task as a prompt: the template it takes, filled; the text editable before it goes.
function TaskPrompt({
  controller,
  snapshot,
  task,
  prompts,
  target,
  folder,
  workspace,
  queueFolder,
  queue,
  onBack,
  onComplete,
}: {
  controller: Controller;
  snapshot: Snapshot;
  task: Task;
  prompts: Prompt[];
  /// The open workspace on the task's repo, when that is not this one.
  target: Target | null;
  folder: string | null;
  workspace: Workspace | null;
  queueFolder: string | null;
  queue: QueueActions | null;
  onBack: () => void;
  onComplete: () => void;
}) {
  const usable = prompts.filter((prompt) => !prompt.broken);
  const [template, setTemplate] = useState<string>(() => templateFor(task, usable)?.key ?? "");
  const chosen = usable.find((prompt) => prompt.key === template) ?? null;
  const [text, setText] = useState(() => fillTemplate(chosen?.body ?? null, task));
  // The comments, often where the real spec is: read when the task opens.
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [commentsFailed, setCommentsFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    readComments(task.id)
      .then((read) => live && setComments(read))
      .catch((error) => live && setCommentsFailed(String(error)));
    return () => {
      live = false;
    };
  }, [task.id]);
  // A template asking for `{{task.comments}}` is filled again once they come,
  // unless the text was edited meanwhile.
  useEffect(() => {
    if (comments === null || comments.length === 0) return;
    const body = usable.find((prompt) => prompt.key === template)?.body ?? null;
    setText((current) => (current === fillTemplate(body, task) ? fillTemplate(body, task, comments) : current));
  }, [comments]); // Only when the comments arrive: the template and task are the ones they were read for.

  const pane = snapshot.focused_pane_id;
  const agent = snapshot.agents.find((entry) => entry.pane_id === pane && entry.agent) ?? null;
  const workspaceId = workspace?.workspace_id ?? null;
  const why: Record<Action, string | null> = {
    here: agent ? null : "The focused pane has no agent.",
    "new-tab": folder && workspaceId ? null : "This workspace has no folder on this computer.",
    queue: !queueFolder ? "This workspace has no folder on this computer." : !queue ? "Another window has the queue." : null,
  };
  const fallback: Action = agent ? "here" : "new-tab";

  const pick = (key: string) => {
    setTemplate(key);
    setText(fillTemplate(usable.find((prompt) => prompt.key === key)?.body ?? null, task, comments ?? []));
  };

  const tabLabel = task.title.length > 24 ? `${task.title.slice(0, 23)}…` : task.title;
  // Which task the prompt came from, so its agent's outcome can be written back.
  const from = { id: task.id, title: task.title };
  const run = (action: Action) => {
    const body = text.trim();
    if (!body || why[action]) return;
    if (action === "here" && pane) {
      // A link that fails to save must not keep the prompt from going.
      const linked = linkTask(from, pane, folder).catch((error) => controller.act(Promise.reject(error)));
      controller.act(linked.then(() => sendPrompt(pane, body)));
    } else if (action === "new-tab" && folder && workspaceId) {
      controller.act(startInNewTab(workspaceId, folder, tabLabel, body, from));
    } else if (action === "queue" && queueFolder && queue) {
      queue.add(queueFolder, body, false, from);
      controller.openQueue();
    }
    onBack();
    controller.focusTerminal();
  };
  // To the task's own repo's workspace, which keeps its queue whichever is focused.
  const runThere = (action: "new-tab" | "queue") => {
    const body = text.trim();
    if (!body || !target) return;
    if (action === "new-tab") controller.act(startInNewTab(target.workspaceId, target.folder, tabLabel, body, from));
    else if (queue) queue.add(target.queueFolder, body, false, from);
    else return;
    onBack();
    controller.focusTerminal();
  };

  return (
    <div
      className="todoist-task"
      onKeyDown={(event) => {
        const command = event.metaKey || event.ctrlKey;
        const index = command ? ["1", "2", "3"].indexOf(event.key) : -1;
        if (event.key === "Escape") onBack();
        else if (index >= 0) run(ACTIONS[index]);
        else if (event.key === "Enter" && command) run(fallback);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="todoist-task-head">
        <button type="button" className="todoist-back" onClick={onBack} title="Back to the tasks (Esc)">
          ‹ Tasks
        </button>
        <span className="todoist-task-links">
          <button type="button" className="todoist-open" onClick={onComplete} title="Complete the task in Todoist, with Undo in the list">
            ✓ Complete
          </button>
          <button type="button" className="todoist-open" onClick={() => controller.act(openUrl(task.url))} title="Open in Todoist">
            Open in Todoist ↗
          </button>
        </span>
      </div>
      <h3 className="todoist-task-title">{task.title}</h3>
      <label className="todoist-template">
        <span>Template</span>
        <select value={template} onChange={(event) => pick(event.target.value)}>
          <option value="">The task alone</option>
          {usable.map((prompt) => (
            <option key={prompt.key} value={prompt.key}>
              /{prompt.name}
              {prompt.scope === "project" ? " · project" : ""}
            </option>
          ))}
        </select>
      </label>
      {target && (
        <div className="todoist-there" role="group" aria-label={`Send to ${target.label}`}>
          <span title={target.folder}>
            For <b>{target.label}</b>
          </span>
          <button type="button" disabled={!text.trim()} title={`A fresh Claude in a new tab of ${target.label}`} onClick={() => runThere("new-tab")}>
            New tab there
          </button>
          <button
            type="button"
            disabled={!queue || !text.trim()}
            title={queue ? `Into ${target.label}'s queue` : "Another window has the queue."}
            onClick={() => runThere("queue")}
          >
            Queue there
          </button>
        </div>
      )}
      <TaskComments comments={comments} failed={commentsFailed} onAdd={() => comments && setText((current) => `${current.trimEnd()}\n\n${commentsBlock(comments)}`)} />
      <textarea className="prompt-text" value={text} spellCheck={false} autoFocus onChange={(event) => setText(event.target.value)} />
      <div className="prompt-actions">
        {ACTIONS.map((action, index) => (
          <button
            key={action}
            type="button"
            className={action === fallback ? "primary" : undefined}
            disabled={!!why[action] || !text.trim()}
            title={why[action] ?? `${LABELS[action]} (⌘${index + 1}${action === fallback ? ", ⌘↵" : ""})`}
            onClick={() => run(action)}
          >
            {LABELS[action]}
          </button>
        ))}
      </div>
    </div>
  );
}

/// The task's comments above its prompt, with a button that adds them to it.
function TaskComments({ comments, failed, onAdd }: { comments: Comment[] | null; failed: string | null; onAdd: () => void }) {
  if (failed) return <p className="empty todoist-comments-note">Comments not read: {failed}</p>;
  if (comments === null) return <p className="empty todoist-comments-note">Reading comments…</p>;
  if (comments.length === 0) return null;
  return (
    <section className="todoist-comments" aria-label="Comments">
      <header>
        <span>
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        <button type="button" onClick={onAdd} title="Add the comments to the prompt below ({{task.comments}} in a template does this)">
          Add to prompt
        </button>
      </header>
      <ol>
        {comments.map((comment, index) => (
          <li key={index}>
            {comment.posted_at && <time dateTime={comment.posted_at}>{comment.posted_at.slice(0, 10)}</time>}
            <p>{comment.content.trim()}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
