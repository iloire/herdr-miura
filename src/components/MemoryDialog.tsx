import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytes, type MemoryScope, type PaneMemory, scopeProcesses, totalBytes } from "../app/memory";
import type { Snapshot } from "../protocol";

/// Every process of a tab or a workspace, the one holding the most memory
/// first, redrawn as the scan repeats while it stays open. A workspace's rows
/// name the tab each runs in.
export function MemoryDialog({
  memory,
  snapshot,
  scope,
  onClose,
}: {
  memory: PaneMemory;
  snapshot: Snapshot;
  scope: MemoryScope;
  onClose: () => void;
}) {
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);
  const rows = scopeProcesses(memory, snapshot.panes, snapshot.tabs, scope);
  const largest = rows[0]?.bytes ?? 0;
  const name =
    scope.kind === "tab"
      ? snapshot.tabs.find((tab) => tab.tab_id === scope.id)?.label
      : snapshot.workspaces.find((workspace) => workspace.workspace_id === scope.id)?.label;
  const count = rows.length === 1 ? "1 process" : `${rows.length} processes`;
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog memory-dialog"
        role="dialog"
        aria-labelledby="memory-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Memory · {scope.kind === "tab" ? "tab" : "workspace"}</span>
            <h2 id="memory-title">{name ?? "Closed"}</h2>
            <p className="worktrees-summary">
              {formatBytes(totalBytes(rows))} across {count}
            </p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        {rows.length === 0 ? (
          <p className="memory-empty">No processes run in its panes on this Mac.</p>
        ) : (
          <ol className="memory-list">
            {rows.map((row) => (
              <li key={row.pid} className="memory-row" title={`${row.command}\npid ${row.pid}`}>
                <span className="memory-name">
                  <strong>{row.name}</strong>
                  <small>
                    {scope.kind === "workspace" && row.tab && <span className="memory-tab">{row.tab}</span>}
                    {row.command}
                  </small>
                </span>
                <span className="memory-pid">{row.pid}</span>
                <span className="memory-bytes">
                  {formatBytes(row.bytes)}
                  <span className="memory-bar" style={{ width: `${largest ? (row.bytes / largest) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="memory-note">
          On macOS each figure is the process's footprint, as Activity Monitor shows it, compressed memory included. Shared
          libraries count once per process, so a total reads high.
        </p>
      </div>
    </div>,
    document.body,
  );
}
