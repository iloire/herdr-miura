// Colors for a diff's lines. A hunk's lines in order are no code that ever
// existed, so the old side (context and removed) and the new side (context and
// added) are each tokenized alone, and each hunk apart: an open string in one
// must not color the next. A hunk has no idea what comes before it, so one that
// starts inside a block comment reads as code until the comment ends.

import type { Token } from "../files/highlight";
import type { DiffLine, ParsedDiff } from "./diff";

/// Past this the diff stays plain: every token is a DOM node. The file view's
/// limit, for the same reason. Not imported, so the UI thread never pulls in
/// `files/highlight.ts` and its grammar chunks.
export const MAX_DIFF_CHARS = 256 * 1024;

export type Tokenize = (code: string) => Promise<Token[][] | null>;

/// Tokens per line, per hunk, or `null` to keep the diff plain: too much text,
/// or `tokenize` said no. It says the same for every hunk, so the first answer
/// ends the work.
export async function tokenizeDiff(diff: ParsedDiff, tokenize: Tokenize): Promise<Token[][][] | null> {
  const chars = diff.hunks.reduce((sum, hunk) => hunk.lines.reduce((lines, line) => lines + line.text.length, sum), 0);
  if (chars > MAX_DIFF_CHARS) return null;
  const side = async (lines: DiffLine[]) => (lines.length ? tokenize(lines.map((line) => line.text).join("\n")) : []);
  const hunks: Token[][][] = [];
  for (const { lines } of diff.hunks) {
    const before = await side(lines.filter((line) => line.kind !== "added"));
    const after = before && (await side(lines.filter((line) => line.kind !== "removed")));
    if (!before || !after) return null;
    let old = 0;
    let current = 0;
    hunks.push(
      lines.map((line) => {
        if (line.kind === "removed") return before[old++];
        if (line.kind === "context") old++;
        return after[current++];
      }),
    );
  }
  return hunks;
}
