import type { CSSProperties } from "react";
import type { Controller } from "../app/controller";
import { DiffIcon, FolderIcon, QueueIcon } from "./icons";

/// The window's top strip, drawn by the app over macOS's hidden titlebar
/// (titleBarStyle Overlay): it drags the window, shows its title, and holds
/// the side panel's switch at its right end, where it costs the tabs nothing.
export function TitleBar({
  controller,
  title,
  hue,
  changes,
  files,
  queue,
  queued,
}: {
  controller: Controller;
  title: string;
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
    <header
      className="titlebar"
      data-tauri-drag-region
      style={hue ? ({ "--hue": hue } as CSSProperties) : undefined}
    >
      <span className="titlebar-title" data-tauri-drag-region>
        {title}
      </span>
      <div className="panel-switch" role="group" aria-label="Side panel">
        <button
          className="panel-toggle"
          title="Changes"
          aria-label="Changes"
          aria-pressed={changes}
          onClick={() => controller.run("review_changes")}
        >
          <DiffIcon />
        </button>
        <button
          className="panel-toggle"
          title="Files"
          aria-label="Files"
          aria-pressed={files}
          onClick={() => controller.run("browse_files")}
        >
          <FolderIcon />
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
    </header>
  );
}
