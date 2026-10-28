import type { ParsedDiff } from "../changes/diff";

export type Loaded = { phase: "loading" } | { phase: "ready"; diff: ParsedDiff } | { phase: "failed"; error: string };

/// One file's hunks, with old and new line numbers, or why there are none.
export function DiffBody({ loaded }: { loaded: Loaded }) {
  if (loaded.phase === "loading") return <p className="empty">Reading the diff…</p>;
  if (loaded.phase === "failed") return <p className="empty error">Could not show the diff: {loaded.error}</p>;
  const { diff } = loaded;
  if (diff.binary) return <p className="empty">Binary file; no lines to show.</p>;
  if (diff.hunks.length === 0) return <p className="empty">No line changes: only the mode or name changed.</p>;
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
            {hunk.lines.map((line, l) => (
              <tr key={l} className={`line ${line.kind}`}>
                <td className="number">{line.oldNumber ?? ""}</td>
                <td className="number">{line.newNumber ?? ""}</td>
                <td className="code">
                  <span className="sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
                  {line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {diff.truncated && <p className="empty">The rest of this diff is not shown: it is too long.</p>}
    </>
  );
}
