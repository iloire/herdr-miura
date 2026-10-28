import { useEffect, useRef, useState } from "react";
import type { ChangedFile, RecentCommit } from "../changes/store";
import { useCommitDiffs } from "../changes/useCommitDiffs";
import type { CommitFilesState } from "../changes/useCommitFiles";
import { DiffBody } from "./DiffBody";

const NO_FILES: ChangedFile[] = [];

/// Every file a commit changed, one diff after another, over the terminal
/// area. `focus` scrolls to one file; ↑/↓ (or k/j) jump between files, Esc
/// closes.
export function CommitDiffView({
  checkout,
  commit,
  state,
  focus,
  onClose,
}: {
  checkout: string;
  commit: RecentCommit;
  state: CommitFilesState | null;
  focus: ChangedFile | null;
  onClose: () => void;
}) {
  const files = state?.phase === "ready" ? state.files : NO_FILES;
  const diffs = useCommitDiffs(checkout, commit.sha, files);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState(0);
  // The file last jumped to. Diffs above it still loading push it down, so
  // it is scrolled back into view until the reader scrolls themselves.
  const pinned = useRef<string | null>(null);

  const jump = (index: number) => {
    const file = files[index];
    if (!file) return;
    setCurrent(index);
    pinned.current = file.path;
    sections.current.get(file.path)?.scrollIntoView({ block: "start" });
  };

  useEffect(() => rootRef.current?.focus(), [commit.sha]);

  useEffect(() => {
    pinned.current = null;
    setCurrent(0);
    bodyRef.current?.scrollTo({ top: 0 });
  }, [commit.sha]);

  useEffect(() => {
    if (focus) jump(files.findIndex((f) => f.path === focus.path));
    // Only a new pick, or the files arriving, moves the view.
  }, [focus, files]);

  useEffect(() => {
    if (pinned.current) sections.current.get(pinned.current)?.scrollIntoView({ block: "start" });
  }, [diffs]);

  // The file at the top of the view, for the position and for ↑/↓.
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body || pinned.current) return;
    let index = 0;
    files.forEach((file, i) => {
      const section = sections.current.get(file.path);
      if (section && section.offsetTop <= body.scrollTop + 1) index = i;
    });
    setCurrent(index);
  };
  const unpin = () => (pinned.current = null);

  const added = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return (
    <div
      className="diff-view"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowDown" || event.key === "j") jump(current + 1);
        else if (event.key === "ArrowUp" || event.key === "k") jump(current - 1);
        else {
          unpin();
          return;
        }
        event.preventDefault();
      }}
    >
      <header className="diff-head">
        <span className="sha" title={`${commit.sha}\n${commit.author}`}>
          {commit.short}
        </span>
        <span className="diff-path" title={commit.subject}>
          {commit.subject}
        </span>
        {files.length > 0 && (
          <>
            <span className="lines">
              <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
            </span>
            <span className="diff-position">
              {current + 1} of {files.length}
            </span>
          </>
        )}
        <button className="icon-button" aria-label="Previous file" title="Previous file (↑)" disabled={current <= 0} onClick={() => jump(current - 1)}>
          ↑
        </button>
        <button
          className="icon-button"
          aria-label="Next file"
          title="Next file (↓)"
          disabled={current >= files.length - 1}
          onClick={() => jump(current + 1)}
        >
          ↓
        </button>
        <button className="icon-button" aria-label="Close diff" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="diff-body commit-diff" ref={bodyRef} onScroll={onScroll} onWheel={unpin} onMouseDown={unpin}>
        {(!state || state.phase === "loading") && <p className="empty">Reading the commit…</p>}
        {state?.phase === "failed" && <p className="empty error">Could not read the commit: {state.error}</p>}
        {files.map((file) => (
          <section
            key={file.path}
            className="commit-file"
            ref={(node) => {
              if (node) sections.current.set(file.path, node);
              else sections.current.delete(file.path);
            }}
          >
            <header className="commit-file-head">
              <span className={`mark mark-${file.mark === "?" ? "untracked" : file.mark}`}>{file.mark}</span>
              <span className="diff-path">{file.path}</span>
              {file.additions !== null && (
                <span className="lines">
                  <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
                </span>
              )}
            </header>
            <DiffBody loaded={diffs.get(file.path) ?? { phase: "loading" }} />
          </section>
        ))}
        {state?.phase === "ready" && state.total_files > files.length && (
          <p className="empty">and {state.total_files - files.length} more files not shown</p>
        )}
      </div>
    </div>
  );
}
