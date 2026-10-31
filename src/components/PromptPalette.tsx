import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Controller } from "../app/controller";
import { changeDrafts, draftKey, loadDrafts, type NewDraft, setEdit, setFresh } from "../app/promptDrafts";
import {
  type Action,
  ACTIONS,
  blocked,
  defaultAction,
  type Library,
  type Prompt,
  promptName,
  readLibrary,
  savePrompt,
  type Scope,
  searchPrompts,
  sendPrompt,
  startInNewTab,
  withBody,
} from "../app/promptLibrary";
import type { QueueActions } from "../app/useQueue";
import type { Snapshot } from "../protocol";
import { NewPrompt } from "./NewPrompt";

const LABELS: Record<Action, string> = { here: "Send to agent", "new-tab": "New tab", queue: "Queue" };
const KEYS: Record<Action, string> = { here: "⌘1", "new-tab": "⌘2", queue: "⌘3" };

/// The prompt library (⌘⇧L): Claude Code's commands from `~/.claude/commands`
/// and the focused workspace's `.claude/commands`, searched on the left, the
/// selected one's text on the right. What is sent is what the box holds; Save
/// (⌘S) writes it to the file, under its frontmatter. New prompt (⌘N) writes a
/// new file. Whatever is typed stays in `promptDrafts` until it is saved, sent
/// or thrown away by hand, so however this closes, it comes back when opened.
export function PromptPalette({
  controller,
  snapshot,
  folder,
  queueFolder,
  queue,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  /// The focused workspace's folder, null when it is not on this Mac.
  folder: string | null;
  /// Where its queue is kept, which a workspace split off a tab has of its own.
  queueFolder: string | null;
  /// The queue's actions, null when this window does not own the queue.
  queue: QueueActions | null;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [drafts, setDrafts] = useState(loadDrafts);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  /// What the new prompt form opened with; null when it is not open.
  const [creating, setCreating] = useState<NewDraft | null>(drafts.fresh);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    readLibrary(folder)
      .then((read) => {
        if (!live) return;
        setLibrary(read);
        const edits = loadDrafts().edits;
        setSelected(Math.max(0, read.prompts.findIndex((entry) => draftKey(entry) in edits)));
      })
      .catch((error) => live && setFailed(String(error)));
    return () => {
      live = false;
    };
  }, [folder]);

  const matches = useMemo(() => (library ? searchPrompts(library.prompts, query) : []), [library, query]);
  const prompt: Prompt | undefined = matches[selected];
  const edit = prompt ? drafts.edits[draftKey(prompt)] : undefined;
  const text = edit?.text ?? prompt?.body ?? "";
  const edited = !!prompt && text !== prompt.body;
  /// Text on screen that a stray click must not take away.
  const unsaved = creating !== null ? !!drafts.fresh : edited;

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (creating === null) search.current?.focus();
  }, [creating]);

  useEffect(() => setSaveFailed(null), [prompt?.key]);

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
    if (creating !== null || !prompt || blocked(prompt, action, can) || !text.trim()) return;
    const body = text.trim();
    const key = draftKey(prompt);
    // Only once it has gone: a send that fails keeps its text.
    const sent = () => void changeDrafts((current) => setEdit(current, key, null));
    if (action === "here" && pane) controller.act(sendPrompt(pane, body).then(sent));
    else if (action === "new-tab" && folder && workspaceId) controller.act(startInNewTab(workspaceId, folder, prompt, body).then(sent));
    else if (action === "queue" && queueFolder && queue) {
      queue.add(queueFolder, body, false);
      sent();
      controller.openQueue();
    }
    close();
  };

  const type = (value: string) => {
    if (!prompt) return;
    const key = draftKey(prompt);
    const base = edit?.base ?? prompt.raw ?? "";
    setDrafts(changeDrafts((current) => setEdit(current, key, value === prompt.body ? null : { text: value, base })));
  };

  const revert = () => {
    if (prompt) setDrafts(changeDrafts((current) => setEdit(current, draftKey(prompt), null)));
    setSaveFailed(null);
  };

  const save = async () => {
    if (!prompt || !edit || !text.trim() || saving) return;
    const key = draftKey(prompt);
    const directory = prompt.scope === "project" ? folder : null;
    setSaving(true);
    setSaveFailed(null);
    try {
      await savePrompt(directory, prompt.path, edit.base, withBody(edit.base, text));
      setDrafts(changeDrafts((current) => setEdit(current, key, null)));
      const read = await readLibrary(folder);
      const position = searchPrompts(read.prompts, query).findIndex((entry) => entry.key === prompt.key);
      setLibrary(read);
      setSelected(Math.max(0, position));
    } catch (error) {
      setSaveFailed(String(error));
      // The file moved on: the next Save is against what it holds now. An
      // entry whose file went stays on screen, or its text would go with it.
      const read = await readLibrary(folder).catch(() => null);
      const current = read?.prompts.find((entry) => entry.key === prompt.key);
      if (read && current?.raw != null) {
        const base = current.raw;
        setLibrary(read);
        setDrafts(changeDrafts((held) => setEdit(held, key, { text, base })));
      }
    } finally {
      setSaving(false);
    }
  };

  const startNew = () =>
    setCreating(drafts.fresh ?? { name: promptName(query), scope: folder ? "project" : "global", description: "", text: "" });

  const created = async (scope: Scope, name: string) => {
    const read = await readLibrary(folder);
    setLibrary(read);
    setQuery("");
    setSelected(Math.max(0, read.prompts.findIndex((entry) => entry.scope === scope && entry.name === name)));
    setDrafts(changeDrafts((current) => setFresh(current, null)));
    setCreating(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const command = event.metaKey || event.ctrlKey;
    if (creating !== null) {
      if (event.key !== "Escape") return;
      setCreating(null);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const index = command ? ["1", "2", "3"].indexOf(event.key) : -1;
    if (event.key === "Escape") close();
    else if (index >= 0) run(ACTIONS[index]);
    else if (event.key === "n" && command) startNew();
    else if (event.key === "s" && command) void save();
    else if (event.key === "Enter" && command) run(fallback);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(event) => (unsaved ? event.preventDefault() : close())}>
      <div
        className="palette prompt-palette"
        role="dialog"
        aria-label="Prompt library"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="prompt-search">
          <input
            autoFocus
            ref={search}
            disabled={creating !== null}
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
              else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                if (library && matches.length === 0) startNew();
                else run(fallback);
              } else return;
              event.preventDefault();
            }}
          />
          <button
            type="button"
            className="worktrees-close"
            aria-label="Close"
            title={creating === null ? "Close (Esc)" : "Close"}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className={creating === null ? "prompt-body" : "prompt-body creating"}>
          <div className="prompt-side">
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
                    {(drafts.edits[draftKey(entry)]?.text ?? entry.body) !== entry.body && <span className="prompt-note"> edited</span>}
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
            <div className="prompt-actions prompt-new">
              <button type="button" disabled={creating !== null} onClick={startNew}>
                New prompt
                {drafts.fresh && <span className="prompt-note">draft</span>}
                <kbd>⌘N</kbd>
              </button>
            </div>
          </div>
          {creating !== null ? (
            <NewPrompt
              draft={creating}
              folder={folder}
              prompts={library?.prompts ?? []}
              onChange={(next) => setDrafts(changeDrafts((current) => setFresh(current, next)))}
              onBack={() => setCreating(null)}
              onDiscard={() => {
                setDrafts(changeDrafts((current) => setFresh(current, null)));
                setCreating(null);
              }}
              onCreated={created}
            />
          ) : (
            <div className="prompt-preview">
              {prompt ? (
                <>
                  <div className="prompt-head">
                    <strong>/{prompt.name}</strong>
                    {prompt.argumentHint && <code>{prompt.argumentHint}</code>}
                    {prompt.overrides && <span className="prompt-note">overrides global</span>}
                    {edited && <span className="prompt-note">unsaved</span>}
                  </div>
                  {prompt.description && <p className="prompt-description">{prompt.description}</p>}
                  <p className="prompt-path" title={`${prompt.dir}/${prompt.path}`}>
                    {prompt.scope === "project" ? ".claude/commands/" : "~/.claude/commands/"}
                    {prompt.path}
                  </p>
                  {prompt.broken && <p className="prompt-problem">Can’t be sent: {prompt.broken}.</p>}
                  {saveFailed && <p className="prompt-problem">{saveFailed}</p>}
                  <textarea
                    className="prompt-text"
                    value={text}
                    spellCheck={false}
                    disabled={prompt.raw === null}
                    onChange={(event) => type(event.target.value)}
                  />
                  <div className="prompt-actions">
                    {edited && (
                      <button type="button" onClick={revert}>
                        Revert
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!edited || !text.trim() || saving}
                      title={edited ? (text.trim() ? "Save to the file" : "An empty prompt can’t be saved.") : "No changes to save."}
                      onClick={() => void save()}
                    >
                      Save
                      <kbd>⌘S</kbd>
                    </button>
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
          )}
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
