import { LoopIcon } from "./icons";

/// Agents that `/loop` will run again, with each loop's tag on hover.
export function LoopMark({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  const label = tags.length === 1 ? `Looping: ${tags[0]}` : `${tags.length} loops: ${tags.join(", ")}`;
  return (
    <span className="loop-mark" title={label} aria-label={label}>
      <LoopIcon />
    </span>
  );
}
