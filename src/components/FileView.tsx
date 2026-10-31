import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { clean } from "../changes/diff";
import type { Token } from "../files/highlight";
import { readFile, type FileContents } from "../files/listing";
import { isMarkdown, renderMarkdown, resolveLink } from "../files/markdown";
import { highlightOffThread } from "../files/offThread";

type Loaded = { phase: "loading" } | { phase: "ready"; contents: FileContents } | { phase: "failed"; error: string };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/// A file's text with line numbers. File content is untrusted, so each line
/// goes through the diff view's `clean`, and tokens are drawn as text. The plain
/// text shows first; tokens replace it inside the same `<pre>`, holding the same
/// characters, so nothing moves.
function TextBody({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n").map(clean), [text]);
  const numbers = useMemo(() => lines.map((_, i) => i + 1).join("\n"), [lines]);
  const code = useMemo(() => lines.join("\n"), [lines]);
  const [tokens, setTokens] = useState<Token[][] | null>(null);

  useEffect(() => {
    const stale = new AbortController();
    setTokens(null);
    void highlightOffThread(code, path, stale.signal).then((result) => {
      if (!stale.signal.aborted) setTokens(result);
    });
    return () => stale.abort();
  }, [code, path]);

  const colored = useMemo(
    () =>
      tokens?.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          {line.map((token, j) => (
            <span key={j} style={{ color: token.color }}>
              {token.content}
            </span>
          ))}
        </Fragment>
      )),
    [tokens],
  );

  return (
    <div className="file-text">
      <pre className="file-numbers" aria-hidden="true">
        {numbers}
      </pre>
      <pre className="file-code">{colored ?? code}</pre>
    </div>
  );
}

/// A Markdown file drawn as a page. A link to the web opens in the browser,
/// one to a heading scrolls to it, one to another file of the checkout opens
/// that file here; images in the checkout are read the way the view reads one.
function MarkdownBody({ root, path, text, onOpen }: { root: string; path: string; text: string; onOpen: (path: string) => void }) {
  const html = useMemo(() => renderMarkdown(text, path), [text, path]);
  const pageRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    for (const img of pageRef.current?.querySelectorAll<HTMLImageElement>("img[data-path]") ?? []) {
      readFile(root, img.dataset.path!)
        .then((contents) => {
          if (current && contents.type === "image") img.src = `data:${contents.mime};base64,${contents.data}`;
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [html, root]);

  return (
    <article
      className="markdown"
      ref={pageRef}
      // markdown-it with `html: false`: the file's own HTML is escaped, see files/markdown.ts.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as Element).closest("a");
        if (!link) return;
        event.preventDefault();
        const target = resolveLink(path, link.getAttribute("href") ?? "");
        if (target?.kind === "external") void openUrl(target.url);
        else if (target?.kind === "anchor") pageRef.current?.querySelector(`[id="${CSS.escape(target.id)}"]`)?.scrollIntoView();
        else if (target?.kind === "file") onOpen(target.path);
      }}
    />
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
/// text with line numbers, a Markdown file as a page (its source a click
/// away), or an image. Esc closes.
export function FileView({
  root,
  path,
  onOpen,
  onClose,
}: {
  root: string;
  path: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [source, setSource] = useState(false);
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
  const markdown = isMarkdown(path) && contents?.type === "text" && contents.text !== "";
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
        {markdown && (
          <div className="segmented" role="radiogroup" aria-label="Show the file as">
            <button role="radio" aria-checked={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button role="radio" aria-checked={source} onClick={() => setSource(true)}>
              Source
            </button>
          </div>
        )}
        <button className="icon-button" aria-label="Close file" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="diff-body">
        {loaded.phase === "loading" && <p className="empty">Reading the file…</p>}
        {loaded.phase === "failed" && <p className="empty error">Could not open the file: {loaded.error}</p>}
        {contents?.type === "text" &&
          (!contents.text ? (
            <p className="empty">The file is empty.</p>
          ) : markdown && !source ? (
            <MarkdownBody root={root} path={path} text={contents.text} onOpen={onOpen} />
          ) : (
            <TextBody text={contents.text} path={path} />
          ))}
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
