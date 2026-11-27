/// The outcome ledger on the status bar: tasks done today, notes parked across
/// every repo, and what waits on you from a session no tab holds any more
/// (the live ones already show gold on their tabs), and the outcomes that can
/// be written back to the Doable task they came from. Opens the Day dialog.
/// Hidden while all are nothing.
export function LedgerChip({
  done,
  parked,
  waiting,
  doable,
  onOpen,
}: {
  done: number;
  parked: number;
  waiting: number;
  doable: number;
  onOpen: () => void;
}) {
  if (done === 0 && parked === 0 && waiting === 0 && doable === 0) return null;
  const label = [
    `${done} done today`,
    `${parked} parked`,
    waiting > 0 && `${waiting} waiting on you from a closed session`,
    doable > 0 && `${doable} to write back to Doable`,
    "Click for the day's outcomes",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button className="ledger-chip" title={label} aria-label={label} onClick={onOpen}>
      {done > 0 && <span className="done">✓ {done}</span>}
      {parked > 0 && <span>◌ {parked}</span>}
      {waiting > 0 && <span className="you">! {waiting}</span>}
      {doable > 0 && <span className="doable">☐ {doable}</span>}
    </button>
  );
}
