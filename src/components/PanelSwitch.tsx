import type { Controller } from "../app/controller";
import { ChangesIcon, FileIcon, HistoryIcon, QueueIcon } from "./icons";

/// Changes, Files, Queue and Sessions, pinned to the window's top right corner: over the
/// tab row, and over the drawer once it opens, so a diff covering the tabs
/// leaves the switch in place.
export function PanelSwitch({
  controller,
  changes,
  changed,
  files,
  queue,
  queued,
  sessions,
  showSessions,
}: {
  controller: Controller;
  changes: boolean;
  /// Uncommitted files in the focused workspace's checkout.
  changed: number;
  files: boolean;
  /// The Queue panel is open.
  queue: boolean;
  /// Prompts waiting in the focused workspace's queue, and whether one runs.
  queued: { waiting: number; running: boolean };
  /// The Sessions panel is open.
  sessions: boolean;
  /// Sessions are this Mac's, so a remote host has no such panel.
  showSessions: boolean;
}) {
  return (
    <div className="panel-switch" role="group" aria-label="Side panel">
      <button
        className="panel-toggle"
        title={`Changes${changed ? `: ${changed} changed` : ""}`}
        aria-label={`Changes${changed ? `, ${changed} changed` : ""}`}
        aria-pressed={changes}
        onClick={() => controller.run("review_changes")}
      >
        <ChangesIcon />
        {changed > 0 && <span className="panel-count changes-count">{changed}</span>}
      </button>
      <button
        className="panel-toggle"
        title="Files"
        aria-label="Files"
        aria-pressed={files}
        onClick={() => controller.run("browse_files")}
      >
        <FileIcon />
      </button>
      <button
        className={`panel-toggle queue-toggle ${queued.running ? "running" : ""}`}
        title={`Queue (⌘⇧A)${queued.waiting ? `: ${queued.waiting} waiting` : ""}`}
        aria-label={`Queue${queued.waiting ? `, ${queued.waiting} waiting` : ""}`}
        aria-pressed={queue}
        onClick={() => controller.run("add_to_queue")}
      >
        <QueueIcon />
        {queued.waiting > 0 && <span className="panel-count">{queued.waiting}</span>}
      </button>
      {showSessions && (
        <button
          className="panel-toggle"
          title="Recent sessions"
          aria-label="Recent sessions"
          aria-pressed={sessions}
          onClick={() => controller.run("recent_sessions")}
        >
          <HistoryIcon />
        </button>
      )}
    </div>
  );
}
