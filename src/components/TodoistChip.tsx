/// Todoist on the status bar: how many of the `todoist.filter` tasks are due
/// today or before. Opens the Todoist panel. Hidden while no token is set or
/// before the first read. Not counted on the Dock badge, which is for agents.
export function TodoistChip({ due, filter, onOpen }: { due: number | null; filter: string; onOpen: () => void }) {
  if (due === null) return null;
  const label = `${due} Todoist ${due === 1 ? "task" : "tasks"} due today or overdue (${filter})\nClick for the Todoist panel`;
  return (
    <button className="ledger-chip todoist-chip" title={label} aria-label={label} onClick={onOpen}>
      <span>☐ {due} today</span>
    </button>
  );
}
