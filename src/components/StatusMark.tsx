import type { AgentStatus } from "../protocol";

// herdr-gpui's `outline` status icons and its `status-orbit` spinner
// (Apache-2.0), drawn in currentColor so CSS picks the status color.

const LABEL: Record<AgentStatus, string> = {
  blocked: "Needs you",
  done: "Done",
  idle: "Idle",
  unknown: "",
  working: "Working",
};

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/// An agent's status as a 14 px mark. A blocked mark carries `count`, the
/// agents waiting on you, when there is more than a single agent behind it.
/// `verified` takes over from the outlined check: the task is finished for
/// sure, where that one only says a turn ended. `note` says what a blocked
/// mark wants of you, when the agent told.
export function StatusMark({
  status,
  count,
  verified,
  note,
}: {
  status: AgentStatus;
  count?: number;
  verified?: boolean;
  note?: string | null;
}) {
  if (status === "unknown") return null;
  if (verified) {
    return (
      <svg className="mark mark-verified" viewBox="0 0 16 16" role="img" aria-label="Finished, nothing left">
        <title>Finished, nothing left: the agent said so and Git agrees</title>
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path className="mark-verified-check" d="M4.5 8.25 7 10.75l4.5-5" fill="none" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const label = note ? `Needs you: ${note}` : count && count > 1 ? `${count} need you` : LABEL[status];
  if (status === "blocked") {
    return (
      <span className="mark mark-blocked" title={label} aria-label={label}>
        {count ?? "!"}
      </span>
    );
  }
  return (
    <svg className={`mark mark-${status}`} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      {status === "working" && (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.3" />
          <path className="mark-orbit" d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="8" cy="8" r="7" {...STROKE} />
          <path d="M4.75 8.25 7 10.5l4.25-4.75" {...STROKE} />
        </>
      )}
      {status === "idle" && <circle cx="8" cy="8" r="3.5" {...STROKE} strokeWidth="1.75" />}
    </svg>
  );
}
