// Unified diffs as hunks of numbered lines. Diff text is file content, so it
// is untrusted: control and direction-override characters are dropped (a
// reversed span could make a line read as something it is not) and every
// line is bounded.

export const MAX_LINE_CHARS = 16_384;
export const MAX_LINES = 50_000;

export type LineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: LineKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: Hunk[];
  binary: boolean;
  /// Lines were dropped past `MAX_LINES`.
  truncated: boolean;
}

// C0 and C1 controls except tab, plus the bidi embedding, override, and
// isolate characters.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function clean(text: string): string {
  const safe = text.replace(UNSAFE, "").replace(/\t/g, "    ");
  return safe.length > MAX_LINE_CHARS ? `${safe.slice(0, MAX_LINE_CHARS)}…` : safe;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnified(text: string): ParsedDiff {
  const hunks: Hunk[] = [];
  let binary = false;
  let truncated = false;
  let count = 0;
  let hunk: Hunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  for (const raw of text.split("\n")) {
    const header = HUNK.exec(raw);
    if (header) {
      hunk = { header: clean(header[3].trim()), lines: [] };
      hunks.push(hunk);
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      continue;
    }
    if (!hunk) {
      if (raw.startsWith("Binary files ")) binary = true;
      continue;
    }
    if (count >= MAX_LINES) {
      truncated = true;
      break;
    }
    const mark = raw[0];
    const body = clean(raw.slice(1));
    if (mark === "+") {
      hunk.lines.push({ kind: "added", oldNumber: null, newNumber: newNumber++, text: body });
    } else if (mark === "-") {
      hunk.lines.push({ kind: "removed", oldNumber: oldNumber++, newNumber: null, text: body });
    } else if (mark === " ") {
      hunk.lines.push({ kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text: body });
    } else {
      // `\ No newline at end of file`, or the empty string after the last newline.
      continue;
    }
    count++;
  }
  return { hunks, binary, truncated };
}

/// An untracked file shown as one hunk of added lines.
export function addedFile(text: string): ParsedDiff {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const truncated = lines.length > MAX_LINES;
  return {
    hunks: [
      {
        header: "new file",
        lines: lines.slice(0, MAX_LINES).map((line, index) => ({
          kind: "added" as const,
          oldNumber: null,
          newNumber: index + 1,
          text: clean(line),
        })),
      },
    ],
    binary: false,
    truncated,
  };
}
