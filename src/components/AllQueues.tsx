import { type CSSProperties, useEffect, useState } from "react";
import { tildePath } from "../app/folder";
import { heldBy, isActive, type Queue, queueDirectory, summary, title } from "../app/queue";
import { useHome } from "../app/useHome";
import type { QueueActions } from "../app/useQueue";
import type { Agent, Snapshot } from "../protocol";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";

/// How long a removed prompt can be brought back, as in the single queue.
const UNDO_MS = 6000;

/// The workspace a queue belongs to, when one is open on its folder.
export interface QueueOwner {
  workspaceId: string;
  label: string;
  hue: string;
}

/// The right-click menu of a waiting prompt, here and in its workspace's queue.
export function waitingMenu(actions: QueueActions, folder: string, id: string): MenuItem[] {
  return [
    { label: "Run Now", icon: "▶", hint: "in the checkout", onSelect: () => actions.startNow(folder, id) },
    { label: "Run in a Worktree Now", icon: "⑂", onSelect: () => actions.runInWorktree(folder, id) },
  ];
}

/// Every workspace's queue on one list: what runs, what waits and why a queue
/// is not moving, without visiting each workspace. A queue's name opens its
/// workspace and that workspace's own queue, where prompts are edited and
/// reordered; here they can only be removed.
export function AllQueues({
  queues,
  ownerOf,
  holders,
  snapshot,
  actions,
  onOpen,
  onGo,
}: {
  queues: Queue[];
  ownerOf: (folder: string) => QueueOwner | null;
  /// What each queue's next prompt waits for, by folder.
  holders: ReadonlyMap<string, Agent>;
  snapshot: Snapshot;
  actions: QueueActions;
  /// Focuses that workspace and shows its own queue.
  onOpen: (workspaceId: string) => void;
  onGo: (tabId: string) => void;
}) {
  const home = useHome();
  const [removed, setRemoved] = useState<{ title: string; undo: () => void } | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  if (queues.length === 0) return <p className="empty">Nothing is queued in any workspace.</p>;
  return (
    <div className="queue-all">
      {queues.map((queue) => {
        const owner = ownerOf(queue.folder);
        const directory = queueDirectory(queue.folder);
        const name = owner?.label ?? directory.split("/").pop() ?? directory;
        const holder = holders.get(queue.folder);
        return (
          <section
            key={queue.folder}
            className={`queue-all-group ${queue.paused ? "paused" : ""}`}
            style={owner ? ({ "--hue": owner.hue } as CSSProperties) : undefined}
          >
            <button
              className="queue-all-head"
              disabled={!owner}
              title={owner ? `Open ${owner.label} and its queue\n${directory}` : `No workspace is open on ${tildePath(directory, home)}`}
              onClick={() => owner && onOpen(owner.workspaceId)}
            >
              <b>{name}</b>
              <span>{summary(queue)}</span>
              {holder && !queue.paused && !queue.items.some(isActive) && <span>{heldBy(holder, snapshot)}</span>}
            </button>
            <ul>
              {queue.items.map((item) => (
                <li
                  key={item.id}
                  className={`queue-all-item ${isActive(item) ? "active" : ""}`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (item.state !== "queued") return;
                    setMenu({ x: event.clientX, y: event.clientY, items: waitingMenu(actions, queue.folder, item.id) });
                  }}
                >
                  <span className="queue-all-n">{isActive(item) ? "▶" : `#${item.n}`}</span>
                  <span className="queue-all-title" title={item.prompt}>
                    {title(item.prompt, 120)}
                  </span>
                  {isActive(item)
                    ? item.tabId && (
                        <button title="Go to its tab" onClick={() => onGo(item.tabId!)}>
                          Go
                        </button>
                      )
                    : (
                        <button
                          className="queue-all-remove"
                          aria-label={`Remove #${item.n}`}
                          title="Remove it from the queue"
                          onClick={() => setRemoved({ title: title(item.prompt, 40), undo: actions.remove(queue.folder, item.id) })}
                        >
                          ×
                        </button>
                      )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {removed && (
        <div className="queue-undo" role="status">
          <span>Removed “{removed.title}”</span>
          <button
            onClick={() => {
              removed.undo();
              setRemoved(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
