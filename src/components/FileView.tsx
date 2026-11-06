import { openUrl } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { lineEnding, loadFileDraft, saveFileDraft, type FileDraft } from "../files/edits";
import { readFile, writeFile, type FileContents } from "../files/listing";
import { isMarkdown, renderMarkdown, resolveLink } from "../files/markdown";

/// CodeMirror, a chunk of its own that loads with the first text file.
const CodeEditor = lazy(() => import("./CodeEditor"));

/// A pause in typing, before the edits are kept in storage.
const KEEP_DRAFT_MS = 400;

type Loaded = { phase: "loading" } | { phase: "ready"; contents: FileContents } | { phase: "failed"; error: string };

/// A text file open for editing; `opened` counts its reads, to start the editor over.
type Editing = FileDraft & { file: string; opened: number };

type SaveProblem = { kind: "changed" } | { kind: "failed"; error: string };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
/// text to edit, a Markdown file as a page (its source a click away), or an
/// image. ⌘S saves, and refuses a file that changed since it was read. Esc or
/// ⌘W closes; edits not saved stay as a draft for the next time the file opens.
/// A file on a remote host is `readOnly`: it can be read there, never written.
export function FileView({
  root,
  path,
  readOnly,
  onOpen,
  onClose,
  onSaved,
}: {
  root: string;
  path: string;
  readOnly: boolean;
  onOpen: (path: string) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [held, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<SaveProblem | null>(null);
  const [source, setSource] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const file = `${root}/${path}`;
  const shownFile = useRef(file);
  shownFile.current = file;
  const saving = useRef(false);
  // Until the next file is read, the last one's text is not this file's.
  const editing = held?.file === file ? held : null;

  const read = (draft: FileDraft | null, isCurrent: () => boolean) => {
    setProblem(null);
    readFile(root, path)
      .then((contents) => {
        if (!isCurrent()) return;
        setLoaded({ phase: "ready", contents });
        if (contents.type !== "text") return setEditing(null);
        const kept = draft && draft.text !== contents.text ? draft : { base: contents.text, text: contents.text };
        setEditing((last) => ({ ...kept, file, opened: (last?.opened ?? 0) + 1 }));
        // An empty file has no page to show.
        if (!contents.text) setSource(true);
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setLoaded({ phase: "failed", error: String(error) });
        setEditing(null);
      });
  };

  useEffect(() => {
    let current = true;
    setLoaded({ phase: "loading" });
    // Drafts are this Mac's: the same path on a remote host is another file.
    read(readOnly ? null : loadFileDraft(root, path), () => current);
    rootRef.current?.focus();
    return () => {
      current = false;
    };
  }, [root, path, readOnly]);

  // Kept shortly after typing stops, and at once on leaving the file.
  const dirty = editing !== null && editing.text !== editing.base;
  const keep = useRef<() => void>(() => {});
  useEffect(() => {
    if (!editing || readOnly) return;
    let pending = true;
    const write = () => {
      if (pending) saveFileDraft(root, path, dirty ? { base: editing.base, text: editing.text } : null);
      pending = false;
    };
    keep.current = write;
    const timer = setTimeout(write, KEEP_DRAFT_MS);
    return () => clearTimeout(timer);
  }, [editing, dirty, root, path, readOnly]);
  useEffect(() => () => keep.current(), [root, path]);

  const save = async (overwrite: boolean) => {
    if (!editing || !dirty || readOnly || saving.current) return;
    const { text, base } = editing;
    saving.current = true;
    try {
      const written = await writeFile(root, path, text, overwrite ? null : base);
      if (shownFile.current !== file) return;
      setProblem(written ? null : { kind: "changed" });
      if (!written) return;
      // What was typed during the save stays an edit.
      setEditing((now) => now && { ...now, base: text });
      onSaved();
    } catch (error) {
      if (shownFile.current === file) setProblem({ kind: "failed", error: String(error) });
    } finally {
      saving.current = false;
    }
  };

  const revert = () => {
    saveFileDraft(root, path, null);
    read(null, () => shownFile.current === file);
  };

  const contents = loaded.phase === "ready" ? loaded.contents : null;
  const markdown = isMarkdown(path) && editing !== null;
  const preview = markdown && !source;
  const base = editing?.base;
  const lineBreak = useMemo(() => (base === undefined ? null : lineEnding(base)), [base]);
  // A null line break is what keeps the editor read-only.
  const editorBreak = readOnly ? null : lineBreak;
  return (
    <div
      className="diff-view file-view"
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "s" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          void save(false);
        }
      }}
    >
      <header className="diff-head">
        <span className="diff-path" title={file}>
          {path}
        </span>
        {editing && readOnly && <span className="file-note">Read-only: on another machine</span>}
        {editing && !readOnly && lineBreak === null && <span className="file-note">Read-only: mixed line endings</span>}
        {dirty && (
          <>
            {problem?.kind === "changed" && <span className="file-note error">Changed on disk since it was read</span>}
            {problem?.kind === "failed" && (
              <span className="file-note error" title={problem.error}>
                Could not save
              </span>
            )}
            <button className="diff-discard" title="Drop your edits and read the file again" onClick={revert}>
              Revert
            </button>
            <button
              className="file-save"
              title={problem?.kind === "changed" ? "Replace what is on disk with your text" : "Save (⌘S)"}
              onClick={() => void save(problem?.kind === "changed")}
            >
              {problem?.kind === "changed" ? "Overwrite" : "Save"}
            </button>
          </>
        )}
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
        <button className="icon-button" aria-label="Close file" title="Close (Esc or ⌘W)" onClick={onClose}>
          ×
        </button>
      </header>
      <div className={`diff-body ${editing && !preview ? "editing" : ""}`}>
        {loaded.phase === "loading" && <p className="empty">Reading the file…</p>}
        {loaded.phase === "failed" && <p className="empty error">Could not open the file: {loaded.error}</p>}
        {editing && (
          <Suspense>
            {/* Stays mounted under the preview, for its undo history. */}
            <CodeEditor
              key={`${file}#${editing.opened}`}
              text={editing.text}
              path={path}
              lineBreak={editorBreak}
              active={!preview}
              onChange={(text) => setEditing((now) => now && { ...now, text })}
            />
          </Suspense>
        )}
        {editing && preview && <MarkdownBody root={root} path={path} text={editing.text} onOpen={onOpen} />}
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
