import { useEffect, useRef, useState } from "react";
import { readDiff, type ChangedFile } from "../changes/store";
import { DiffBody, type Loaded } from "./DiffBody";

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
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);

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
        <DiffBody loaded={loaded} path={file.path} />
      </div>
    </div>
  );
}
