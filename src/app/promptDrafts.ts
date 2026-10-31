// What is typed in the prompt library and not yet saved or sent. It is written
// to storage on every change, so closing the palette, by any of its many ways,
// reloading or quitting loses nothing: opening it again brings the text back.

import type { Prompt, Scope } from "./promptLibrary";

const KEY = "prompt-drafts";

/// An edit of a file's text, and the file it began from: saving is refused if
/// the file is no longer that, as it may be by the time a draft comes back.
export interface PromptEdit {
  text: string;
  base: string;
}

/// The new prompt form.
export interface NewDraft {
  name: string;
  scope: Scope;
  description: string;
  text: string;
}

export interface PromptDrafts {
  /// By `draftKey`.
  edits: Record<string, PromptEdit>;
  fresh: NewDraft | null;
}

/// The file's own path: `Prompt.key` is the same in every project.
export const draftKey = (prompt: Pick<Prompt, "dir" | "path">) => `${prompt.dir}/${prompt.path}`;

export function loadDrafts(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): PromptDrafts {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<PromptDrafts> | null;
    return { edits: saved?.edits ?? {}, fresh: saved?.fresh ?? null };
  } catch {
    return { edits: {}, fresh: null };
  }
}

/// Applies `change` to what storage holds now, not to what this palette read,
/// so another window's drafts stay. Returns the result, which still stands for
/// this palette's life if storage refuses it.
export function changeDrafts(
  change: (drafts: PromptDrafts) => PromptDrafts,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): PromptDrafts {
  const drafts = change(loadDrafts(storage));
  try {
    storage?.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // The text stays on screen; only the copy that outlives the palette is lost.
  }
  return drafts;
}

export function setEdit(drafts: PromptDrafts, key: string, edit: PromptEdit | null): PromptDrafts {
  const { [key]: _old, ...edits } = drafts.edits;
  return { ...drafts, edits: edit ? { ...edits, [key]: edit } : edits };
}

/// A form with nothing in it is no draft.
export function setFresh(drafts: PromptDrafts, fresh: NewDraft | null): PromptDrafts {
  const empty = !fresh || !(fresh.name || fresh.description.trim() || fresh.text.trim());
  return { ...drafts, fresh: empty ? null : fresh };
}
