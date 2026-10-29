import { TerminalIcon } from "./icons";

/// How many agents run in a workspace or tab, in place of listing each.
export function AgentCount({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "agent" : "agents"}`;
  return (
    <span className="agent-count" title={label} aria-label={label}>
      <TerminalIcon />
      {count}
    </span>
  );
}
