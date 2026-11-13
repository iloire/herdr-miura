import { openUrl } from "@tauri-apps/plugin-opener";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { Controller } from "../app/controller";
import { type Action, ACTIONS, type Prompt, readLibrary, sendPrompt, startInNewTab } from "../app/promptLibrary";
import { fillTemplate, localDay, matchingTasks, overdue, readTasks, sortTasks, type Task, type Tasks, templateFor } from "../app/todoist";
import type { QueueActions } from "../app/useQueue";
import type { Snapshot, Workspace } from "../protocol";

/// How often an open panel asks Todoist again.
const READ_MS = 60_000;

const LABELS: Record<Action, string> = { here: "Send to agent", "new-tab": "New tab", queue: "Queue" };

/// Todoist's priority colors, urgent first; normal has no mark.
const PRIORITY: Record<number, string> = { 4: "p1", 3: "p2", 2: "p3" };

/// The tasks the `todoist.filter` setting matches, in the right-hand drawer.
/// Clicking one opens it as a prompt: a library template filled with the task,
/// editable, then sent to the focused agent, a fresh Claude in a new tab, or
/// the workspace's queue, as the prompt library sends.
export function TodoistPanel({
  controller,
  snapshot,
  workspace,
  hue,
  filter,
  folder,
  queueFolder,
  queue,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace | null;
  hue: string;
  filter: string;
  /// The focused workspace's folder on this computer, for project templates and a new tab.
  folder: string | null;
  queueFolder: string | null;
  /// The queue's actions, null when this window does not own the queue.
  queue: QueueActions | null;
}) {
  const [read, setRead] = useState<Tasks | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [open, setOpen] = useState<Task | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      readTasks(filter)
        .then((next) => {
          if (!live) return;
          setRead(next);
          setFailed(null);
        })
        .catch((error) => live && setFailed(String(error)));
    };
    refresh();
    const timer = window.setInterval(refresh, READ_MS);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [filter]);

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
  const shown = useMemo(() => sortTasks(matchingTasks(read?.tasks ?? [], query)), [read, query]);

  const head = (
    <span className="queue-head-title" title={`Todoist filter: ${filter}`}>
      Todoist <b>{filter}</b>
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
          folder={folder}
          workspace={workspace}
          queueFolder={queueFolder}
          queue={queue}
          onBack={() => setOpen(null)}
        />
      </aside>
    );
  }

  return (
    <aside className="changes sessions-panel todoist-panel" aria-label="Todoist" style={{ "--hue": hue } as CSSProperties}>
      <header className="changes-head queue-head">{head}</header>
      {failed && <div className="queue-banner" role="status">{failed}</div>}
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
      {read && read.tasks.length > 0 && shown.length === 0 && <p className="empty">No task holds “{query.trim()}”.</p>}
      <div className="sessions-list">
        <ul className="todoist-list">
          {shown.map((task) => (
            <li key={task.id}>
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
            </li>
          ))}
        </ul>
        {read?.truncated && <p className="empty">Only the first {read.tasks.length} tasks are listed.</p>}
      </div>
    </aside>
  );
}

/// One task as a prompt: the template it takes, filled; the text editable before it goes.
function TaskPrompt({
  controller,
  snapshot,
  task,
  prompts,
  folder,
  workspace,
  queueFolder,
  queue,
  onBack,
}: {
  controller: Controller;
  snapshot: Snapshot;
  task: Task;
  prompts: Prompt[];
  folder: string | null;
  workspace: Workspace | null;
  queueFolder: string | null;
  queue: QueueActions | null;
  onBack: () => void;
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

  const run = (action: Action) => {
    const body = text.trim();
    if (!body || why[action]) return;
    if (action === "here" && pane) controller.act(sendPrompt(pane, body));
    else if (action === "new-tab" && folder && workspaceId) {
      const label = task.title.length > 24 ? `${task.title.slice(0, 23)}…` : task.title;
      controller.act(startInNewTab(workspaceId, folder, label, body));
    } else if (action === "queue" && queueFolder && queue) {
      queue.add(queueFolder, body, false);
      controller.openQueue();
    }
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
        <button type="button" className="todoist-open" onClick={() => controller.act(openUrl(task.url))} title="Open in Todoist">
          Open in Todoist ↗
        </button>
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
