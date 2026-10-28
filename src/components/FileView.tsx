import { useEffect, useMemo, useRef, useState } from "react";
import { clean } from "../changes/diff";
import { readFile, type FileContents } from "../files/listing";

type Loaded = { phase: "loading" } | { phase: "ready"; contents: FileContents } | { phase: "failed"; error: string };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/// A file's text with line numbers. File content is untrusted, so each line
/// goes through the diff view's `clean`.
function TextBody({ text }: { text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n").map(clean), [text]);
  const numbers = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);
  return (
    <div className="file-text">
      <pre className="file-numbers" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="file-code">{lines.join("\n")}</pre>
    </div>
  );
}

function ImageBody({ src, alt }: { src: string; alt: string }) {
  const [dimensions, setDimensions] = useState<string | null>(null);
  return (
    <div className="file-image">
      <img
        src={src}
        alt={alt}
        onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)}
      />
      {dimensions && <p className="file-dimensions">{dimensions}</p>}
    </div>
  );
}

/// One file of the checkout over the terminal area, as the diff view sits:
/// text with line numbers, or an image. Esc closes.
export function FileView({ root, path, onClose }: { root: string; path: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ phase: "loading" });
    readFile(root, path)
      .then((contents) => current && setLoaded({ phase: "ready", contents }))
      .catch((error) => current && setLoaded({ phase: "failed", error: String(error) }));
    rootRef.current?.focus();
    return () => {
      current = false;
    };
  }, [root, path]);

  const contents = loaded.phase === "ready" ? loaded.contents : null;
  return (
    <div
      className="diff-view file-view"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="diff-head">
        <span className="diff-path" title={`${root}/${path}`}>
          {path}
        </span>
        <button className="icon-button" aria-label="Close file" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="diff-body">
        {loaded.phase === "loading" && <p className="empty">Reading the file…</p>}
        {loaded.phase === "failed" && <p className="empty error">Could not open the file: {loaded.error}</p>}
        {contents?.type === "text" &&
          (contents.text ? <TextBody text={contents.text} /> : <p className="empty">The file is empty.</p>)}
        {contents?.type === "image" && (
          <ImageBody src={`data:${contents.mime};base64,${contents.data}`} alt={path.split("/").pop() ?? path} />
        )}
        {contents?.type === "binary" && <p className="empty">Binary file, {size(contents.size)}; nothing to show.</p>}
        {contents?.type === "too_large" && (
          <p className="empty">The file is {size(contents.size)}, too large to show here.</p>
        )}
      </div>
    </div>
  );
}
