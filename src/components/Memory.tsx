import { formatBytes, type MemoryScope, type PaneMemory, scopeProcesses, totalBytes } from "../app/memory";
import type { Snapshot } from "../protocol";

/// The memory a tab's or workspace's processes hold, as a figure that opens
/// the list of them, largest first. Nothing while none is measured.
export function MemoryButton({
  memory,
  snapshot,
  scope,
  onOpen,
}: {
  memory: PaneMemory;
  snapshot: Snapshot;
  scope: MemoryScope;
  onOpen: (scope: MemoryScope) => void;
}) {
  const processes = scopeProcesses(memory, snapshot.panes, snapshot.tabs, scope);
  if (processes.length === 0) return null;
  const total = formatBytes(totalBytes(processes));
  const top = processes
    .slice(0, 3)
    .map((process) => `${formatBytes(process.bytes)} ${process.name}`)
    .join("\n");
  return (
    <button
      type="button"
      className="memory"
      title={`${total} in this ${scope.kind}'s ${processes.length} processes\n${top}\nClick to list them all`}
      aria-label={`Memory: ${total}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(scope);
      }}
    >
      {total}
    </button>
  );
}
