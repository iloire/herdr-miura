/// Doable on the status bar: how many of the `doable.view` tasks are due
/// today or before. Opens the Doable panel. Hidden while no token is set or
/// before the first read. Not counted on the Dock badge, which is for agents.
export function DoableChip({ due, filter, onOpen }: { due: number | null; filter: string; onOpen: () => void }) {
  if (due === null) return null;
  const label = `${due} Doable ${due === 1 ? "task" : "tasks"} due today or overdue (${filter})\nClick for the Doable panel`;
  return (
    <button className="ledger-chip doable-chip" title={label} aria-label={label} onClick={onOpen}>
      <span>☐ {due} today</span>
    </button>
  );
}
