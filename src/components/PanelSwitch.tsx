import type { CSSProperties } from "react";
import type { Controller } from "../app/controller";
import { ChangesIcon, FileIcon, QueueIcon } from "./icons";

/// Changes, Files and Queue, pinned to the window's top right corner: over the
/// tab row, and over the drawer once it opens, so a diff covering the tabs
/// leaves the switch in place.
export function PanelSwitch({
  controller,
  hue,
  changes,
  files,
  queue,
  queued,
}: {
  controller: Controller;
  /// The focused workspace's color, for the open panel's key.
  hue: string | null;
  changes: boolean;
  files: boolean;
  /// The Queue panel is open.
  queue: boolean;
  /// Prompts waiting in the focused workspace's queue, and whether one runs.
  queued: { waiting: number; running: boolean };
}) {
  return (
    <div
      className="panel-switch"
      role="group"
      aria-label="Side panel"
      style={hue ? ({ "--hue": hue } as CSSProperties) : undefined}
    >
      <button
        className="panel-toggle"
        title="Changes"
        aria-label="Changes"
        aria-pressed={changes}
        onClick={() => controller.run("review_changes")}
      >
        <ChangesIcon />
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
        {queued.waiting > 0 && <span className="queue-toggle-count">{queued.waiting}</span>}
      </button>
    </div>
  );
}
