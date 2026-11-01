import { useEffect, useMemo, useState } from "react";
import { openFile } from "../app/agentFile";
import {
  type Bands,
  bands,
  type ContextNode,
  fileInFolder,
  partCut,
  partLabel,
  readSessionContext,
  type SessionContext,
  type SharedItem,
  sharedItems,
  shortPath,
} from "../app/sessionContext";
import { CONTEXT_LIMITS, contextLevel, contextTitle, formatTokens, sessionName, sessionOf } from "../app/sessionUsage";
import type { Snapshot } from "../protocol";

/// How often the open dialog rereads the transcripts, each of them whole.
const POLL_MS = 30_000;
/// The left rail's row that shows every open session at once.
const ALL = "all";

type Contexts = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; found: Map<string, SessionContext | null> };

function useContexts(key: string): Contexts {
  const [contexts, setContexts] = useState<Contexts>({ phase: "loading" });
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    let reading = false;
    let live = true;
    const refresh = () => {
      if (reading) return;
      reading = true;
      readSessionContext(ids)
        .then((found) => live && setContexts({ phase: "ready", found }))
        .catch(() => live && setContexts((held) => (held.phase === "ready" ? held : { phase: "failed" })))
        .finally(() => (reading = false));
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [key]);
  return contexts;
}

interface Row {
  id: string;
  name: string;
  session: SessionContext;
}

/// What fills the context of the Claude sessions in panes, to show what is worth
/// cutting. The left rail compares the sessions; the right side says what to cut
/// across all of them, or what one of them holds.
export function ContextDialog({
  snapshot,
  focus,
  onClose,
}: {
  snapshot: Snapshot | null;
  /// The session to open on.
  focus: string;
  onClose: () => void;
}) {
  const agents = useMemo(
    () => (snapshot?.agents ?? []).flatMap((agent) => {
      const id = sessionOf(agent);
      return id ? [{ id, name: sessionName(agent) }] : [];
    }),
    [snapshot],
  );
  const key = [...new Set(agents.map((agent) => agent.id))].sort().join("\n");
  const contexts = useContexts(key);
  const [selected, setSelected] = useState(focus);

  const rows = useMemo(() => {
    if (contexts.phase !== "ready") return [];
    const seen = new Set<string>();
    return agents
      .flatMap(({ id, name }) => {
        const session = contexts.found.get(id);
        if (!session || seen.has(id)) return [];
        seen.add(id);
        return [{ id, name, session }];
      })
      .sort((a, b) => b.session.context - a.session.context);
  }, [agents, contexts]);
  const shown = rows.find((row) => row.id === selected) ?? null;
  const span = Math.max(CONTEXT_LIMITS.over, ...rows.map((row) => row.session.context));

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette usage-dialog context-dialog"
        role="dialog"
        aria-labelledby="context-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Claude context</span>
            <h2 id="context-title">{shown ? shown.name : `${rows.length} open ${rows.length === 1 ? "session" : "sessions"}`}</h2>
            <p className="worktrees-summary">{summary(rows, shown)}</p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        {contexts.phase === "loading" && <p className="usage-empty">Reading the open sessions' transcripts…</p>}
        {contexts.phase === "failed" && <p className="usage-empty">Could not read the transcripts in ~/.claude/projects.</p>}
        {contexts.phase === "ready" && rows.length === 0 && (
          <p className="usage-empty">No Claude session is reporting from a pane. Sessions show here after their next prompt.</p>
        )}
        {rows.length > 0 && (
          <div className="context-body">
            <nav className="context-rail" aria-label="Open sessions">
              <button className={`context-pick ${shown ? "" : "selected"}`} onClick={() => setSelected(ALL)}>
                <span className="context-pick-name">What to cut first</span>
              </button>
              {rows.map((row) => (
                <button
                  key={row.id}
                  className={`context-pick ${row === shown ? "selected" : ""}`}
                  title={row.name}
                  onClick={() => setSelected(row.id)}
                >
                  <span className="context-pick-name">{row.name}</span>
                  <span className={`usage-row-context ctx-${contextLevel(row.session.context)}`} title={contextTitle(row.session.context)}>
                    {formatTokens(row.session.context)}
                  </span>
                  <Strip parts={bands(row.session)} span={span} />
                </button>
              ))}
            </nav>
            <div className="context-detail">
              {shown ? <Session session={shown.session} span={span} /> : <Shared sessions={rows.map((row) => row.session)} />}
              <p className="usage-foot">
                Totals are measured from what Anthropic reports. The split is estimated from characters. A change to a memory
                file reaches new sessions, not the ones already open.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function summary(rows: Row[], shown: Row | null): string {
  const parts = rows.map((row) => bands(row.session));
  if (shown) {
    const { fixed, yours, conversation } = bands(shown.session);
    return `${formatTokens(shown.session.context)} in context: ${formatTokens(yours)} you can cut, ${formatTokens(conversation)} of conversation, ${formatTokens(fixed)} fixed.`;
  }
  if (rows.length === 0) return "";
  const yours = parts.reduce((sum, part) => sum + part.yours, 0);
  const total = rows.reduce((sum, row) => sum + row.session.context, 0);
  return `${formatTokens(total)} in context, ${formatTokens(yours)} of it loaded before the first prompt and yours to cut. Every turn starts from all of it.`;
}

/// One session's context as a ribbon, ticked at the sizes the header marks. All
/// strips share `span`, so their lengths compare.
function Strip({ parts, span }: { parts: Bands; span: number }) {
  const width = (tokens: number) => `${(tokens / span) * 100}%`;
  const label = `${formatTokens(parts.fixed)} fixed, ${formatTokens(parts.yours)} yours to cut, ${formatTokens(parts.conversation)} conversation`;
  return (
    <span className="context-strip" role="img" aria-label={label} title={label}>
      <span className="band-fixed" style={{ width: width(parts.fixed) }} />
      <span className="band-yours" style={{ width: width(parts.yours) }} />
      <span className="band-conversation" style={{ width: width(parts.conversation) }} />
      <i style={{ left: width(CONTEXT_LIMITS.high) }} />
      <i style={{ left: width(CONTEXT_LIMITS.over) }} />
    </span>
  );
}

/// What to cut across the open sessions, ranked by what it would free.
function Shared({ sessions }: { sessions: SessionContext[] }) {
  const items = sharedItems(sessions);
  const top = items[0]?.total ?? 0;
  return (
    <section className="usage-section">
      <h3 className="usage-heading">
        <span>Cut once, every session gets lighter</span>
        <span className="usage-readout">tokens across open sessions</span>
      </h3>
      <ul className="context-tree">
        {items.map((item) => (
          <SharedRow key={`${item.part}\n${item.name}`} item={item} top={top} />
        ))}
      </ul>
    </section>
  );
}

function SharedRow({ item, top }: { item: SharedItem; top: number }) {
  const node: ContextNode = { name: item.name, tokens: item.total, count: 1, path: item.path, children: item.children };
  return (
    <Branch
      node={node}
      top={top}
      label={item.path ? shortPath(item.path) : item.name}
      note={`${partLabel(item.part)}, ${formatTokens(item.each)} × ${item.sessions}`}
      hint={partCut(item.part)}
      yours
    />
  );
}

function Session({ session, span }: { session: SessionContext; span: number }) {
  const parts = bands(session);
  const startup = [...session.startup].sort((a, b) => b.tokens - a.tokens);
  const conversation = [...session.conversation].sort((a, b) => b.tokens - a.tokens);
  const top = Math.max(...startup.map((part) => part.tokens), ...conversation.map((part) => part.tokens));
  return (
    <>
      <Strip parts={parts} span={span} />
      <ul className="usage-key context-key">
        <li><span className="usage-swatch band-fixed" />Fixed<span className="usage-key-value">{formatTokens(parts.fixed)}</span></li>
        <li><span className="usage-swatch band-yours" />Yours to cut<span className="usage-key-value">{formatTokens(parts.yours)}</span></li>
        <li><span className="usage-swatch band-conversation" />Conversation<span className="usage-key-value">{formatTokens(parts.conversation)}</span></li>
      </ul>
      <section className="usage-section">
        <h3 className="usage-heading">
          <span>Loaded before the first prompt</span>
          <span className="usage-readout"><b>{formatTokens(session.opening)}</b> measured</span>
        </h3>
        <ul className="context-tree">
          {startup.map((part) => (
            <Branch key={part.name} node={part} top={top} label={partLabel(part.name)} hint={partCut(part.name)} yours={partCut(part.name) !== undefined} />
          ))}
        </ul>
      </section>
      <section className="usage-section">
        <h3 className="usage-heading">
          <span>This conversation</span>
          <span className="usage-readout">/compact or a fresh session clears it</span>
        </h3>
        <ul className="context-tree">
          {conversation.map((part) => (
            <Branch
              key={part.name}
              node={part}
              top={top}
              label={partLabel(part.name)}
              hint={part.name === "unitemized" ? "What compaction kept that the transcript does not spell out, or a compaction since the last reply." : undefined}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

/// A row that opens onto what it is made of. Bars compare siblings: the sections
/// of a file against each other, which is what deciding what to trim takes.
function Branch({
  node,
  top,
  label,
  note,
  hint,
  yours = false,
}: {
  node: ContextNode;
  top: number;
  label?: string;
  note?: string;
  hint?: string;
  yours?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const folds = node.children.length > 0 || hint !== undefined;
  const name = label ?? (node.path ? shortPath(node.path) : node.name);
  return (
    <li className={yours ? "yours" : undefined}>
      <div className="context-row">
        <button className="context-row-name" disabled={!folds} aria-expanded={folds ? open : undefined} title={node.path ?? name} onClick={() => setOpen(!open)}>
          <span className="context-fold" aria-hidden="true">{folds ? (open ? "▾" : "▸") : ""}</span>
          <span className="context-row-label">{name}</span>
          {note && <span className="context-row-note">{note}</span>}
        </button>
        {node.count > 1 && <span className="context-row-count" title={`Went in ${node.count} times`}>×{node.count}</span>}
        {node.path && <Open path={node.path} />}
        <span className="context-row-track"><span style={{ width: `${top > 0 ? (node.tokens / top) * 100 : 0}%` }} /></span>
        <span className="usage-row-value">{formatTokens(node.tokens)}</span>
      </div>
      {open && hint && <p className="context-hint">{hint}</p>}
      {open && node.children.length > 0 && (
        <ul className="context-tree">
          {node.children.map((child) => (
            <Branch key={child.name} node={child} top={node.children[0].tokens} yours={yours} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Open({ path }: { path: string }) {
  const { root, name } = fileInFolder(path);
  return (
    <button className="context-open" title={`Open ${shortPath(path)} in VS Code`} onClick={() => void openFile(root, name).catch(() => {})}>
      Open
    </button>
  );
}
