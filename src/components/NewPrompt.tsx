import { type KeyboardEvent, useState } from "react";
import { createPrompt, nameTaken, type Prompt, promptFile, promptName, type Scope } from "../app/promptLibrary";

/// The prompt library's form for a new command file, in place of the preview.
/// It writes `<name>.md` into the chosen folder and never over a file.
export function NewPrompt({
  name: initial,
  folder,
  prompts,
  onCancel,
  onCreated,
}: {
  name: string;
  /// The focused workspace's folder, null when only a global prompt can be made.
  folder: string | null;
  prompts: readonly Prompt[];
  onCancel: () => void;
  onCreated: (scope: Scope, name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [scope, setScope] = useState<Scope>(folder ? "project" : "global");
  const [description, setDescription] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const taken = name ? nameTaken(prompts, name, scope) : null;
  const overrides = scope === "project" && prompts.some((prompt) => prompt.name === name && prompt.scope === "global");
  const ready = !!name && !!text.trim() && !taken;

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setFailed(null);
    try {
      await createPrompt(scope === "project" ? folder : null, name, promptFile(description, text));
      await onCreated(scope, name);
    } catch (error) {
      setFailed(String(error));
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void save();
  };

  return (
    <div className="prompt-preview" onKeyDown={onKeyDown}>
      <div className="prompt-new-fields">
        <label className="settings-field">
          <span>Name</span>
          <input
            autoFocus={!initial}
            value={name}
            placeholder="review-diff"
            spellCheck={false}
            onChange={(event) => setName(promptName(event.target.value))}
          />
        </label>
        {folder && (
          <div className="settings-field">
            <span>Where</span>
            <div className="prompt-where">
              {(["project", "global"] as const).map((where) => (
                <button key={where} type="button" aria-pressed={scope === where} onClick={() => setScope(where)}>
                  {where === "project" ? "This project" : "Global"}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="settings-field wide">
          <span>Description (optional)</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>
      <p className="prompt-path">
        {scope === "project" ? ".claude/commands/" : "~/.claude/commands/"}
        {name || "…"}.md
        {overrides && <span className="prompt-note"> overrides global</span>}
      </p>
      {(taken || failed) && <p className="prompt-problem">{taken ?? failed}</p>}
      <textarea
        autoFocus={!!initial}
        className="prompt-text"
        value={text}
        spellCheck={false}
        placeholder="What the prompt says. $ARGUMENTS takes what follows /name."
        onChange={(event) => setText(event.target.value)}
      />
      <div className="prompt-actions">
        <button type="button" onClick={onCancel}>
          Cancel
          <kbd>esc</kbd>
        </button>
        <button type="button" className="primary" disabled={!ready} onClick={() => void save()}>
          Create
          <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
