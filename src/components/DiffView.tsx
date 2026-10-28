import { useEffect, useRef, useState } from "react";
import { addedFile, parseUnified, type ParsedDiff } from "../changes/diff";
import { fileDiff, type ChangedFile, type RecentCommit } from "../changes/store";

type Loaded = { phase: "loading" } | { phase: "ready"; diff: ParsedDiff } | { phase: "failed"; error: string };

/// One file's diff over the terminal area: its uncommitted change, or with
/// `commit`, its change in that commit. ↑/↓ (or k/j) step through `files`,
/// the checkout's or the commit's, Esc closes.
export function DiffView({
  checkout,
  commit,
  files,
  file,
  onSelect,
  onClose,
}: {
  checkout: string;
  commit: RecentCommit | null;
  files: ChangedFile[];
  file: ChangedFile;
  onSelect: (file: ChangedFile) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const sha = commit?.sha ?? null;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ phase: "loading" });
    fileDiff(checkout, file, sha)
      .then((result) => {
        if (!current) return;
        const diff = result.type === "untracked" ? addedFile(result.text) : parseUnified(result.text);
        setLoaded({ phase: "ready", diff });
      })
      .catch((error) => current && setLoaded({ phase: "failed", error: String(error) }));
    rootRef.current?.focus();
    return () => {
      current = false;
    };
  }, [checkout, file, sha]);

  const index = files.findIndex((f) => f.path === file.path);
  const step = (by: number) => {
    const next = files[index + by];
    if (next) onSelect(next);
  };

  return (
    <div
      className="diff-view"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowDown" || event.key === "j") step(1);
        else if (event.key === "ArrowUp" || event.key === "k") step(-1);
        else return;
        event.preventDefault();
      }}
    >
      <header className="diff-head">
        <span className={`mark mark-${file.mark === "?" ? "untracked" : file.mark}`}>{file.mark}</span>
        {commit && (
          <span className="sha" title={`${commit.subject}\n${commit.author}`}>
            {commit.short}
          </span>
        )}
        <span className="diff-path">{file.path}</span>
        <span className="diff-position">
          {index + 1} of {files.length}
        </span>
        <button className="icon-button" aria-label="Previous file" title="Previous file (↑)" disabled={index <= 0} onClick={() => step(-1)}>
          ↑
        </button>
        <button
          className="icon-button"
          aria-label="Next file"
          title="Next file (↓)"
          disabled={index >= files.length - 1}
          onClick={() => step(1)}
        >
          ↓
        </button>
        <button className="icon-button" aria-label="Close diff" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="diff-body">
        {loaded.phase === "loading" && <p className="empty">Reading the diff…</p>}
        {loaded.phase === "failed" && <p className="empty error">Could not show the diff: {loaded.error}</p>}
        {loaded.phase === "ready" && loaded.diff.binary && <p className="empty">Binary file; no lines to show.</p>}
        {loaded.phase === "ready" && !loaded.diff.binary && loaded.diff.hunks.length === 0 && (
          <p className="empty">No line changes: only the mode or name changed.</p>
        )}
        {loaded.phase === "ready" &&
          loaded.diff.hunks.map((hunk, h) => (
            <table className="hunk" key={h}>
              <thead>
                <tr>
                  <th colSpan={3}>{hunk.header || " "}</th>
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
        {loaded.phase === "ready" && loaded.diff.truncated && (
          <p className="empty">The rest of this diff is not shown: it is too long.</p>
        )}
      </div>
    </div>
  );
}
