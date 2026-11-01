// What editing a file needs to know from its text, and the edits not saved yet.

/// The line ending a file uses throughout, or `null` for a mix. The editor
/// holds lines, so a mix could not be written back as it was.
export function lineEnding(text: string): "\n" | "\r\n" | null {
  const rest = text.replaceAll("\r\n", "");
  const crlf = rest.length < text.length;
  if (rest.includes("\r") || (crlf && rest.includes("\n"))) return null;
  return crlf ? "\r\n" : "\n";
}

const INDENT_SPACES = /^ {2,8}(?=\S)/gm;

/// One level of indentation as the file writes it: a tab, its narrowest run of
/// spaces, or two for a file with neither. A run of one is an aligned comment.
export function indentOf(text: string): string {
  if (/^\t/m.test(text)) return "\t";
  let width = Infinity;
  for (const [spaces] of text.matchAll(INDENT_SPACES)) width = Math.min(width, spaces.length);
  return " ".repeat(width === Infinity ? 2 : width);
}

export interface FileDraft {
  /// What the file held when the edits began, so a save can tell it changed.
  base: string;
  text: string;
}

const KEY = "herdr.file-draft:";
const draftKey = (root: string, path: string) => `${KEY}${root}/${path}`;

/// Edits kept in storage: leaving the file or a restart of the app, which Edge
/// does on every commit, must not lose them.
export function loadFileDraft(
  root: string,
  path: string,
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): FileDraft | null {
  try {
    return JSON.parse(storage?.getItem(draftKey(root, path)) ?? "null") as FileDraft | null;
  } catch {
    return null;
  }
}

/// `null` forgets the file's draft.
export function saveFileDraft(
  root: string,
  path: string,
  draft: FileDraft | null,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage,
): void {
  try {
    if (draft) storage?.setItem(draftKey(root, path), JSON.stringify(draft));
    else storage?.removeItem(draftKey(root, path));
  } catch {
    // The edits stay on screen; only the copy that outlives the view is lost.
  }
}
