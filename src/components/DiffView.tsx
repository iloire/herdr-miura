import { useEffect, useMemo, useRef, useState } from "react";
import { readDiff, type ChangedFile } from "../changes/store";
import { onRemote, type WebRepo } from "../changes/forge";
import { DiffBody, type DiffLinks, type Loaded, type OnLineLink } from "./DiffBody";

/// One file's uncommitted change over the terminal area. ↑/↓ (or k/j) step
/// through the checkout's `files`, Esc closes.
export function DiffView({
  checkout,
  files,
  file,
  onSelect,
  onClose,
  onDiscard,
  covered,
  web,
  head,
  onLineLink,
}: {
  checkout: string;
  files: ChangedFile[];
  file: ChangedFile;
  onSelect: (file: ChangedFile) => void;
  onClose: () => void;
  /// `null` where this Mac cannot write to the checkout.
  onDiscard: (() => void) | null;
  /// A dialog holds the keys; they come back here once it closes.
  covered: boolean;
  /// `origin` on GitHub or GitLab, and HEAD's commit: the old side's line
  /// numbers link to the file there. The new side is not committed yet.
  web: WebRepo | null;
  head: string | null;
  onLineLink: OnLineLink;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);
  // A new file has no old side, and a rename's is under its old path.
  const oldOnWeb = onRemote(file.mark);
  const links = useMemo<DiffLinks | null>(
    () => (web && head && oldOnWeb ? { links: { repo: web, path: file.path, old: head, new: null }, onLink: onLineLink } : null),
    [web, head, oldOnWeb, file.path, onLineLink],
  );

  useEffect(() => {
    let current = true;
    setLoaded({ phase: "loading" });
    readDiff(checkout, file, null)
      .then((diff) => current && setLoaded({ phase: "ready", diff }))
      .catch((error) => current && setLoaded({ phase: "failed", error: String(error) }));
    rootRef.current?.focus();
    return () => {
      current = false;
    };
  }, [checkout, file]);

  useEffect(() => {
    if (!covered) rootRef.current?.focus();
  }, [covered]);

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
        <span className="diff-path">{file.path}</span>
        <span className="diff-position">
          {index + 1} of {files.length}
        </span>
        {onDiscard && (
          <button className="diff-discard" title="Discard this file's changes" onClick={onDiscard}>
            Discard…
          </button>
        )}
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
        <DiffBody loaded={loaded} path={file.path} links={links} />
      </div>
    </div>
  );
}
