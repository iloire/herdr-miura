import { memo, useEffect, useState } from "react";
import type { ParsedDiff } from "../changes/diff";
import { tokenizeDiff } from "../changes/diffTokens";
import type { Token } from "../files/highlight";
import { highlightOffThread } from "../files/offThread";
import { TokenSpans } from "./TokenSpans";

export type Loaded = { phase: "loading" } | { phase: "ready"; diff: ParsedDiff } | { phase: "failed"; error: string };

/// Memoized: a commit's view redraws as it scrolls, and a long diff is many spans.
/// The plain text shows first; tokens replace it, holding the same characters,
/// so nothing moves.
const Hunks = memo(function Hunks({ diff, path }: { diff: ParsedDiff; path: string }) {
  // Kept with their diff: the next commit's same file arrives without an
  // unmount, and tokens must never draw over lines that are not theirs.
  const [colored, setColored] = useState<{ diff: ParsedDiff; tokens: Token[][][] | null } | null>(null);

  useEffect(() => {
    const stale = new AbortController();
    void tokenizeDiff(diff, (code) => highlightOffThread(code, path, stale.signal)).then((tokens) => {
      if (!stale.signal.aborted) setColored({ diff, tokens });
    });
    return () => stale.abort();
  }, [diff, path]);

  const tokens = colored?.diff === diff ? colored.tokens : null;

  return (
    <>
      {diff.hunks.map((hunk, h) => (
        <table className="hunk" key={h}>
          <thead>
            <tr>
              <th colSpan={3}>{hunk.header || " "}</th>
            </tr>
          </thead>
          <tbody>
            {hunk.lines.map((line, l) => {
              const spans = tokens?.[h][l];
              return (
                <tr key={l} className={`line ${line.kind}`}>
                  <td className="number">{line.oldNumber ?? ""}</td>
                  <td className="number">{line.newNumber ?? ""}</td>
                  <td className="code">
                    <span className="sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
                    {spans ? <TokenSpans tokens={spans} /> : line.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
      {diff.truncated && <p className="empty">The rest of this diff is not shown: it is too long.</p>}
    </>
  );
});

/// One file's hunks, with old and new line numbers, or why there are none.
/// `path` chooses the language.
export function DiffBody({ loaded, path }: { loaded: Loaded; path: string }) {
  if (loaded.phase === "loading") return <p className="empty">Reading the diff…</p>;
  if (loaded.phase === "failed") return <p className="empty error">Could not show the diff: {loaded.error}</p>;
  const { diff } = loaded;
  if (diff.binary) return <p className="empty">Binary file; no lines to show.</p>;
  if (diff.hunks.length === 0) return <p className="empty">No line changes: only the mode or name changed.</p>;
  return <Hunks diff={diff} path={path} />;
}
