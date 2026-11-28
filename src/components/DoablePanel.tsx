import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { Controller } from "../app/controller";
import { type Action, ACTIONS, type Prompt, readLibrary, sendPrompt, startInNewTab } from "../app/promptLibrary";
import {
  dueLabel,
  fillTemplate,
  isMapped,
  localDay,
  matchingTasks,
  overdue,
  projectFor,
  readProjects,
  projectView,
  quickAdd,
  sendTarget,
  setDone,
  sortTasks,
  type Target,
  type Task,
  taskRepo,
  tasksFor,
  templateFor,
  VIEWS,
  viewedProject,
} from "../app/doable";
import { linkTask } from "../app/doableLinks";
import {
  accepted,
  askTriage,
  parseSuggestions,
  repoName,
  setLabels,
  type Suggestion,
  TRIAGE_MAX,
  triagePrompt,
  triageRepos,
} from "../app/doableTriage";
import type { QueueActions } from "../app/useQueue";
import type { DoableTasks } from "../app/useDoableTasks";
import type { Snapshot, Workspace } from "../protocol";
import { RefreshIcon } from "./icons";

const LABELS: Record<Action, string> = { here: "Send to agent", "new-tab": "New tab", queue: "Queue" };

/// Doable's priority colors, urgent first; normal has no mark.
const PRIORITY: Record<number, string> = { 4: "p1", 3: "p2", 2: "p3" };

/// The tasks in the `doable.view` setting's view, in the right-hand drawer:
/// only the focused workspace's when `doable.projects` maps its folder, with a
/// switch to all of them. Clicking one opens it as a prompt: a library template filled with the task,
/// editable, then sent to the focused agent, a fresh Claude in a new tab, or
/// the workspace's queue, as the prompt library sends.
export function DoablePanel({
  controller,
  snapshot,
  workspace,
  hue,
  filter,
  view,
  onView,
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
  /// `doable.view`, the panel's view unless another is picked.
  filter: string;
  /// The view picked in the panel; null for `filter`, the setting's.
  view: string | null;
  onView: (view: string | null) => void;
  /// The view's tasks, read by `App`: `filter`'s count on the status bar too.
  tasks: DoableTasks;
  /// `doable.projects`: project names to repo folders.
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
  // Tasks completed here, hidden at once: `closing` while Doable is asked,
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

  // Doable's projects, for the view picker.
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (tasks.off) return;
    let live = true;
    readProjects()
      .then((next) => live && setNames(next))
      .catch(() => live && setNames([]));
    return () => {
      live = false;
    };
  }, [tasks.off]);
  const viewed = viewedProject(view, names);
  const shownFilter = view ?? filter;

  const today = localDay();
  // Only the setting's view is narrowed to this repo; a picked view lists what it names.
  const mapped = view === null && isMapped(folder, projects, home);
  const folders = useMemo(() => targets.map((target) => target.folder), [targets]);
  const scoped = useMemo(() => {
    const tasks = (read?.tasks ?? []).filter((task) => !completed.has(task.id));
    return mapped && !showAll && folder ? tasksFor(tasks, folder, projects, home, folders) : tasks;
  }, [read, completed, mapped, showAll, folder, projects, home, folders]);
  const shown = useMemo(() => sortTasks(matchingTasks(scoped, query)), [scoped, query]);
  const head = (
    <>
      <span className="queue-head-title" title={`Doable view: ${shownFilter}`}>
        Doable
      </span>
      {!tasks.off && (
        <button
          type="button"
          className={`icon-button doable-refresh ${tasks.reading ? "reading" : ""}`}
          aria-label="Refresh tasks"
          title="Read the tasks from Doable again (it does every minute while this panel is open)"
          disabled={tasks.reading}
          onClick={refresh}
        >
          <RefreshIcon />
        </button>
      )}
    </>
  );
  const picker = (
    <select
      className="doable-view"
      aria-label="Doable view"
      title={`Doable view: ${shownFilter}`}
      value={view ?? ""}
      onChange={(event) => onView(event.target.value || null)}
    >
      <option value="">{VIEWS.find(([query]) => query === filter)?.[1] ?? filter}</option>
      {VIEWS.filter(([query]) => query !== filter).map(([query, label]) => (
        <option key={query} value={query}>
          {label}
        </option>
      ))}
      {view !== null && !viewed && !VIEWS.some(([query]) => query === view) && <option value={view}>{view}</option>}
      {names.length > 0 && (
        <optgroup label="Projects">
          {names.map((name) => (
            <option key={name} value={projectView(name)}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
  const scope = mapped && (
    <span className="queue-scope" role="group" aria-label="Which tasks">
      <button aria-pressed={!showAll} onClick={() => setShowAll(false)} title="The tasks doable.projects or a repo link sends to this workspace's repo">
        This repo
      </button>
      <button aria-pressed={showAll} onClick={() => setShowAll(true)} title="Every task in the view">
        All
      </button>
    </span>
  );

  if (open) {
    return (
      <aside className="changes sessions-panel doable-panel" aria-label="Doable" style={{ "--hue": hue } as CSSProperties}>
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
    <aside className="changes sessions-panel doable-panel" aria-label="Doable" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {failed && (
        <div className="queue-banner" role="status">
          <p>{failed}</p>
          {!tasks.off && (
            <button type="button" disabled={tasks.reading} onClick={refresh}>
              {tasks.reading ? "Reconnecting…" : "Reconnect"}
            </button>
          )}
        </div>
      )}
      {tasks.off ? (
        scope && <div className="queue-scope-row">{scope}</div>
      ) : (
        <div className="files-filter doable-tools">
          <div className="doable-tools-row">
            {picker}
            {scope}
          </div>
          <QuickAdd controller={controller} project={viewed ?? projectFor(folder, projects, home)} onAdded={refresh} />
          {read && read.tasks.length > 0 && (
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
          )}
        </div>
      )}
      {!read && !failed && <p className="empty">Reading Doable…</p>}
      {read?.tasks.length === 0 && (
        <div className="queue-off">
          <p>
            No tasks match <b>{shownFilter}</b>.{view === null && " The view is in Settings."}
          </p>
        </div>
      )}
      {read && read.tasks.length > 0 && scoped.length === 0 && (
        <div className="queue-off">
          <p>
            None of the {read.tasks.length} tasks is for this repo. <button className="doable-show-all" onClick={() => setShowAll(true)}>Show all</button>
          </p>
        </div>
      )}
      {undoable && (
        <div className="doable-done-bar" role="status">
          <span title={undoable.title}>Completed “{undoable.title}”</span>
          <button type="button" title="Reopen it in Doable" onClick={() => undo(undoable)}>
            Undo
          </button>
        </div>
      )}
      {scoped.length > 0 && shown.length === 0 && <p className="empty">No task holds “{query.trim()}”.</p>}
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
        <ul className="doable-list">
          {shown.map((task) => (
            <li key={task.id} className="doable-item">
              <button className="session-row doable-row" title={task.description || task.title} onClick={() => setOpen(task)}>
                <span className="session-title">
                  {PRIORITY[task.priority] && <span className={`doable-priority ${PRIORITY[task.priority]}`} aria-label={`priority ${5 - task.priority}`} />}
                  {task.title}
                </span>
                {task.description.trim() && <span className="session-prompt">{task.description.trim()}</span>}
                <span className="session-meta">
                  {task.due && <span className={overdue(task, today) ? "doable-overdue" : undefined}>{dueLabel(task, today)}</span>}
                  {task.project && <span>{task.project}</span>}
                  {task.labels.map((label) => (
                    <span key={label} className="doable-label">
                      @{label}
                    </span>
                  ))}
                </span>
              </button>
              <button
                type="button"
                className="doable-complete"
                aria-label={`Complete “${task.title}”`}
                title="Complete in Doable"
                onClick={() => complete(task)}
              />
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

interface Proposal {
  task: Task;
  suggestion: Suggestion;
  /// The task's labels once accepted, and its repo link when that changes.
  labels: string[];
  repo: string | null;
}

/// Suggest: a cheap Claude (Haiku, no tools) reads the listed tasks and
/// proposes a repo and a template for each. Each proposal is accepted (a
/// repo link to the repo, and a label named as the template, are set in
/// Doable) or refused; nothing changes until accepted.
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
          const change = task && accepted(task, suggestion, names, routed(task));
          return task && change ? [{ task, suggestion, ...change }] : [];
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
      setLabels(proposal.task.id, proposal.labels, proposal.repo)
        .then(() => {
          drop(proposal.task.id);
          onChanged();
        })
        .finally(() => setWriting(null)),
    );
  };

  return (
    <section className="doable-triage" aria-label="Suggestions">
      <div className="doable-triage-head">
        <button
          type="button"
          disabled={asking}
          title={`A cheap Claude (Haiku, no tools) suggests a repo and a template for the ${asked.length} listed tasks${tasks.length > asked.length ? ` (the first ${TRIAGE_MAX})` : ""}. Nothing changes until you accept.`}
          onClick={suggest}
        >
          {asking ? "Suggesting…" : "Suggest repo and template"}
        </button>
        {proposals !== null && (
          <button type="button" className="doable-batch-clear" onClick={() => setProposals(null)}>
            Close
          </button>
        )}
      </div>
      {failed && <p className="empty">Suggest failed: {failed}</p>}
      {proposals?.length === 0 && <p className="empty">Nothing to suggest: each task has its repo and template, or the model was unsure.</p>}
      {proposals && proposals.length > 0 && (
        <ul>
          {proposals.map((proposal) => (
            <li key={proposal.task.id} className="doable-proposal">
              <p className="doable-proposal-title" title={proposal.task.title}>
                {proposal.task.title}
              </p>
              <p className="doable-proposal-what">
                {proposal.suggestion.repo && <span>repo {proposal.suggestion.repo}</span>}
                {proposal.suggestion.template && <span>/{proposal.suggestion.template}</span>}
                {proposal.suggestion.why && <em>{proposal.suggestion.why}</em>}
              </p>
              <div className="doable-proposal-row">
                <button
                  type="button"
                  disabled={writing !== null}
                  title={`Set the task's labels in Doable to ${proposal.labels.map((label) => `@${label}`).join(" ")}${proposal.repo ? `, and its repo link to ${proposal.repo}` : ""}`}
                  onClick={() => accept(proposal)}
                >
                  {writing === proposal.task.id ? "Accepting…" : "Accept"}
                </button>
                <button type="button" className="doable-batch-clear" onClick={() => drop(proposal.task.id)}>
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

/// A box that adds a task to Doable, read as Doable's quick add reads it
/// (`tomorrow 10am p1 #Project @label`). No date means today; no `#project`
/// means the project mapped to this workspace's repo, else the Inbox. Says
/// where it went, with a link.
function QuickAdd({ controller, project, onAdded }: { controller: Controller; project: string | null; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Task | null>(null);
  const where = project ?? "Inbox";
  const add = () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    quickAdd(text, project)
      .then((task) => {
        setTitle("");
        setAdded(task);
        onAdded();
      })
      .catch((error) => controller.act(Promise.reject(error)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="doable-add">
      <input
        type="text"
        placeholder={`Add a task to ${where}`}
        aria-label={`Add a Doable task to ${where}`}
        title="Typed as in Doable: tomorrow 10am, p1, #Project, @label. No date means today."
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
        <button type="button" className="doable-added" title={added.url} onClick={() => controller.act(openUrl(added.url))}>
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
    setText(fillTemplate(usable.find((prompt) => prompt.key === key)?.body ?? null, task));
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
      className="doable-task"
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
      <div className="doable-task-head">
        <button type="button" className="doable-back" onClick={onBack} title="Back to the tasks (Esc)">
          ‹ Tasks
        </button>
        <span className="doable-task-links">
          <button type="button" className="doable-open" onClick={onComplete} title="Complete the task in Doable, with Undo in the list">
            ✓ Complete
          </button>
          <button type="button" className="doable-open" onClick={() => controller.act(openUrl(task.url))} title="Open in Doable">
            Open in Doable ↗
          </button>
        </span>
      </div>
      <h3 className="doable-task-title">{task.title}</h3>
      <label className="doable-template">
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
        <div className="doable-there" role="group" aria-label={`Send to ${target.label}`}>
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
