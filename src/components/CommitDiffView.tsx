import { useEffect, useRef, useState } from "react";
import { formatMoment, relativeTime } from "../app/time";
import { splitMessage } from "../changes/commit";
import { clean } from "../changes/diff";
import type { ChangedFile, RecentCommit } from "../changes/store";
import { useCommitDiffs } from "../changes/useCommitDiffs";
import type { CommitFilesState } from "../changes/useCommitFiles";
import { FileRow } from "./CommitList";
import { DiffBody } from "./DiffBody";

const NO_FILES: ChangedFile[] = [];

/// A whole commit over the terminal area: what it says, its files, then each
/// file's diff. What the commit list already knows shows at once, so stepping
/// never waits on Git to say which commit this is. ↑/↓ step along the list,
/// k/j jump between files, Space and Page Up/Down scroll, Esc closes.
export function CommitDiffView({
  checkout,
  commit,
  state,
  onStep,
  onClose,
}: {
  checkout: string;
  commit: RecentCommit;
  state: CommitFilesState | null;
  onStep: (by: number) => void;
  onClose: () => void;
}) {
  const files = state?.phase === "ready" ? state.files : NO_FILES;
  const diffs = useCommitDiffs(checkout, commit.sha, files);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  // The file at the top of the view, -1 above the first.
  const [current, setCurrent] = useState(-1);
  // The file last jumped to. Diffs above it still loading push it down, so
  // it is scrolled back into view until the reader scrolls themselves.
  const pinned = useRef<string | null>(null);

  const jump = (index: number) => {
    if (index === -1) {
      pinned.current = null;
      setCurrent(-1);
      bodyRef.current?.scrollTo({ top: 0 });
      return;
    }
    const file = files[index];
    if (!file) return;
    setCurrent(index);
    pinned.current = file.path;
    sections.current.get(file.path)?.scrollIntoView({ block: "start" });
  };

  useEffect(() => rootRef.current?.focus(), [commit.sha]);

  useEffect(() => {
    pinned.current = null;
    setCurrent(-1);
    bodyRef.current?.scrollTo({ top: 0 });
  }, [commit.sha]);

  useEffect(() => {
    if (pinned.current) sections.current.get(pinned.current)?.scrollIntoView({ block: "start" });
  }, [diffs]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body || pinned.current) return;
    let index = -1;
    files.forEach((file, i) => {
      const section = sections.current.get(file.path);
      if (section && section.offsetTop <= body.scrollTop + 1) index = i;
    });
    setCurrent(index);
  };
  const unpin = () => (pinned.current = null);
  const page = (direction: number) => {
    unpin();
    const body = bodyRef.current;
    body?.scrollBy({ top: direction * body.clientHeight * 0.9 });
  };

  const added = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  // The subject alone already gives an old commit its title and details.
  const message = splitMessage(state?.phase === "ready" ? state.message : commit.subject);

  return (
    <div
      className="diff-view"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowDown") onStep(1);
        else if (event.key === "ArrowUp") onStep(-1);
        else if (event.key === "j") jump(current + 1);
        else if (event.key === "k") jump(current - 1);
        else if (event.key === "PageDown" || (event.key === " " && !event.shiftKey)) page(1);
        else if (event.key === "PageUp" || event.key === " ") page(-1);
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
        <span className="diff-path" title={message.title}>
          {message.title}
        </span>
        {files.length > 0 && (
          <>
            <span className="lines">
              <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
            </span>
            <span className="diff-position">
              {Math.max(current, 0) + 1} of {files.length}
            </span>
          </>
        )}
        <button className="icon-button" aria-label="Previous file" title="Previous file (k)" disabled={current < 0} onClick={() => jump(current - 1)}>
          ↑
        </button>
        <button
          className="icon-button"
          aria-label="Next file"
          title="Next file (j)"
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
        <section className="commit-info">
          <h2 className="commit-title">{clean(message.title)}</h2>
          {message.body && <p className="commit-body">{message.body.split("\n").map(clean).join("\n")}</p>}
          <p className="commit-meta">
            <span>{commit.author}</span>
            <span title={relativeTime(commit.time)}>{formatMoment(commit.time * 1000)}</span>
            <span>{commit.sha}</span>
          </p>
          {files.length > 0 && (
            <ul className="file-list">
              {files.map((file, index) => (
                <FileRow key={file.path} file={file} current={index === current} onOpen={() => jump(index)} />
              ))}
            </ul>
          )}
        </section>
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
