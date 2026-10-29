import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import {
  type Action,
  ACTIONS,
  blocked,
  defaultAction,
  type Library,
  type Prompt,
  readLibrary,
  searchPrompts,
  sendPrompt,
  startInNewTab,
} from "../app/promptLibrary";
import type { QueueActions } from "../app/useQueue";
import type { Snapshot } from "../protocol";

const LABELS: Record<Action, string> = { here: "Send to agent", "new-tab": "New tab", queue: "Queue" };
const KEYS: Record<Action, string> = { here: "⌘1", "new-tab": "⌘2", queue: "⌘3" };

/// The prompt library (⌘⇧L): Claude Code's commands from `~/.claude/commands`
/// and the focused workspace's `.claude/commands`, searched on the left, the
/// selected one's text on the right, editable before it is sent. What is sent
/// is what the box holds; the file is never changed.
export function PromptPalette({
  controller,
  snapshot,
  folder,
  queue,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  /// The focused workspace's folder (the queue's), null when it is not on this Mac.
  folder: string | null;
  /// The queue's actions, null when this window does not own the queue.
  queue: QueueActions | null;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    readLibrary(folder)
      .then((read) => live && setLibrary(read))
      .catch((error) => live && setFailed(String(error)));
    return () => {
      live = false;
    };
  }, [folder]);

  const matches = useMemo(() => (library ? searchPrompts(library.prompts, query) : []), [library, query]);
  const prompt: Prompt | undefined = matches[selected];
  const text = prompt && draft?.key === prompt.key ? draft.text : (prompt?.body ?? "");

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const pane = snapshot?.focused_pane_id ?? null;
  const agent = snapshot?.agents.find((a) => a.pane_id === pane && a.agent) ?? null;
  const workspaceId = snapshot?.focused_workspace_id ?? null;
  const can = { agent: !!agent, folder: !!(folder && workspaceId), queue: !!queue };
  const fallback = prompt ? defaultAction(prompt, can.agent) : "here";

  const close = () => {
    controller.closeLibrary();
    controller.focusTerminal();
  };

  const run = (action: Action) => {
    if (!prompt || blocked(prompt, action, can) || !text.trim()) return;
    const body = text.trim();
    if (action === "here" && pane) controller.act(sendPrompt(pane, body));
    else if (action === "new-tab" && folder && workspaceId) controller.act(startInNewTab(workspaceId, folder, prompt, body));
    else if (action === "queue" && folder && queue) {
      queue.add(folder, body, false);
      controller.openQueue();
    }
    close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const command = event.metaKey || event.ctrlKey;
    const index = command ? ["1", "2", "3"].indexOf(event.key) : -1;
    if (event.key === "Escape") close();
    else if (index >= 0) run(ACTIONS[index]);
    else if (event.key === "Enter" && command) run(fallback);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette prompt-palette"
        role="dialog"
        aria-label="Prompt library"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder={folder ? "Search prompts: this project's, then global" : "Search global prompts"}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setSelected((s) => Math.min(matches.length - 1, s + 1));
            else if (event.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
            else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) run(fallback);
            else return;
            event.preventDefault();
          }}
        />
        <div className="prompt-body">
          <ul className="palette-list prompt-list" role="listbox" ref={list}>
            {matches.map((entry, index) => (
              <li
                key={entry.key}
                role="option"
                aria-selected={index === selected}
                className={entry.broken ? "broken" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSelected(index)}
                onDoubleClick={() => run(defaultAction(entry, can.agent))}
              >
                <span className="prompt-name">
                  {entry.broken && <span className="prompt-broken-mark">!</span>}/{entry.name}
                  {entry.group && <span className="prompt-group">{entry.group}</span>}
                </span>
                <span className={`prompt-scope ${entry.scope}`}>{entry.scope}</span>
              </li>
            ))}
            {library && matches.length === 0 && (
              <li className="empty">
                {library.prompts.length === 0
                  ? "No prompts yet: add .md files to ~/.claude/commands or this repo's .claude/commands."
                  : `No prompt matches “${query}”.`}
              </li>
            )}
            {!library && !failed && <li className="empty">Reading prompts…</li>}
            {failed && <li className="empty">{failed}</li>}
          </ul>
          <div className="prompt-preview">
            {prompt ? (
              <>
                <div className="prompt-head">
                  <strong>/{prompt.name}</strong>
                  {prompt.argumentHint && <code>{prompt.argumentHint}</code>}
                  {prompt.overrides && <span className="prompt-note">overrides global</span>}
                </div>
                {prompt.description && <p className="prompt-description">{prompt.description}</p>}
                <p className="prompt-path" title={`${prompt.dir}/${prompt.path}`}>
                  {prompt.scope === "project" ? ".claude/commands/" : "~/.claude/commands/"}
                  {prompt.path}
                </p>
                {prompt.broken && <p className="prompt-problem">Can’t be sent: {prompt.broken}.</p>}
                <textarea
                  className="prompt-text"
                  value={text}
                  spellCheck={false}
                  disabled={!!prompt.broken && !prompt.body}
                  onChange={(event) => setDraft({ key: prompt.key, text: event.target.value })}
                />
                <div className="prompt-actions">
                  {ACTIONS.map((action) => {
                    const why = blocked(prompt, action, can);
                    return (
                      <button
                        key={action}
                        type="button"
                        className={action === fallback ? "primary" : undefined}
                        disabled={!!why || !text.trim()}
                        title={why ?? (action === fallback ? `${LABELS[action]} (↵ in the search, ⌘↵ anywhere)` : undefined)}
                        onClick={() => run(action)}
                      >
                        {LABELS[action]}
                        <kbd>{KEYS[action]}</kbd>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="prompt-description">Nothing selected.</p>
            )}
          </div>
        </div>
        {library?.notes.map((note) => (
          <p key={note} className="prompt-footnote">
            {note}
          </p>
        ))}
      </div>
    </div>
  );
}
