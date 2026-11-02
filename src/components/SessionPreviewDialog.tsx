import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readSessionPreview, type RecentSession, type SessionPreview } from "../app/recentSessions";
import { formatTokens, shortModel } from "../app/sessionUsage";
import { relativeTime } from "../app/time";

type Read = { phase: "loading" } | { phase: "failed"; error: string } | { phase: "ready"; preview: SessionPreview };

/// A session's latest messages, so a click on a row shows what it was before
/// anything starts. Resuming costs a tab and tokens, and may not be what was
/// wanted. Transcript text is shown as plain text, never as markup.
export function SessionPreviewDialog({
  session,
  where,
  blocked,
  movedHome,
  onResume,
  onClose,
}: {
  session: RecentSession;
  /// The folder a tab would open in, for reading.
  where: string;
  /// Why it cannot be resumed; null when it can.
  blocked: string | null;
  movedHome: boolean;
  onResume: () => void;
  onClose: () => void;
}) {
  const [read, setRead] = useState<Read>({ phase: "loading" });
  const messages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setRead({ phase: "loading" });
    readSessionPreview(session.id)
      .then((preview) => live && setRead({ phase: "ready", preview }))
      .catch((error) => live && setRead({ phase: "failed", error: String(error) }));
    return () => {
      live = false;
    };
  }, [session.id]);
  // The latest message is the one that says where it was left.
  useLayoutEffect(() => {
    const list = messages.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [read]);

  const title = session.title ?? session.prompt;
  const preview = read.phase === "ready" ? read.preview : null;
  return createPortal(
    <div className="palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="palette host-key session-preview"
        role="dialog"
        aria-label={`Session: ${title}`}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <h2 title={title}>{title}</h2>
        <p className="session-preview-facts">
          <span>{where}</span>
          {session.branch && <span>{session.branch}</span>}
          <span>{relativeTime(session.updated_at)}</span>
          {preview?.model && <span>{shortModel(preview.model)}</span>}
          {preview?.context_tokens != null && <span>{formatTokens(preview.context_tokens)} context</span>}
          {session.queue && <span>Queue run</span>}
        </p>
        <div className="session-preview-messages" ref={messages}>
          {read.phase === "loading" && <p className="session-preview-note">Reading the session…</p>}
          {read.phase === "failed" && <p className="session-preview-note">Could not read this session: {read.error}</p>}
          {preview?.messages.length === 0 && <p className="session-preview-note">No messages near the end of this session, only tool calls.</p>}
          {preview?.messages.map((message, index) => (
            <section key={index} className={message.from_user ? "session-message user" : "session-message"}>
              <h3>{message.from_user ? "You" : "Claude"}</h3>
              <p>{message.text}</p>
            </section>
          ))}
        </div>
        {(blocked || movedHome) && <p className="session-preview-note">{blocked ?? "Worktree removed, opens in the main checkout"}</p>}
        <div className="host-key-actions">
          <button autoFocus={Boolean(blocked)} className="host-key-button" onClick={onClose}>
            Close
          </button>
          {!blocked && (
            <button autoFocus className="host-key-button primary" onClick={onResume}>
              Resume
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
