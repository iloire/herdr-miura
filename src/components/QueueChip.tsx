import { isActive, type Queue, summary, title } from "../app/queue";
import { QueueIcon } from "./icons";

/// An hourglass and how many prompts wait in a workspace's queue, amber while
/// it is paused, pulsing while one runs; hovering names what is next, clicking
/// opens the queue. A span, not a button: on a workspace card it sits inside
/// the card's button.
export function QueueChip({ queue, onOpen }: { queue: Queue | null; onOpen: () => void }) {
  if (!queue) return null;
  const waiting = queue.items.filter((item) => item.state === "queued");
  const running = queue.items.some(isActive);
  if (waiting.length === 0 && !running && !queue.paused) return null;
  const next = waiting.slice(0, 3).map((item) => `#${item.n} ${title(item.prompt, 50)}`);
  const label = ["Queue: " + summary(queue), ...next, "Click to open"].join("\n");
  const classes = ["queue-chip", queue.paused && "paused", running && "running"].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      role="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The card's own click would focus the workspace instead.
        event.stopPropagation();
        onOpen();
      }}
    >
      <QueueIcon />
      {waiting.length > 0 && waiting.length}
    </span>
  );
}
