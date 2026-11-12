import type { CSSProperties, ReactNode } from "react";
import type { PlacedAgent, StatusSections } from "../app/agentsView";
import type { Controller } from "../app/controller";
import { type Outcome, repoName } from "../app/ledger";
import type { Snapshot } from "../protocol";
import { AgentRow } from "./CardDetails";
import { ChevronIcon } from "./icons";
import { StatusMark } from "./StatusMark";

/// What waits on you from a session no tab holds any more, from the outcome
/// ledger: a row resumes the session, its × says it was dealt with.
export interface ClosedAsks {
  outcomes: Outcome[];
  onResume: (outcome: Outcome) => void;
  onClear: (outcome: Outcome) => void;
}

/// The sidebar's Agents tab: every active agent by what it wants of you,
/// whatever workspace or folded group it is in. Waiting on you first (closed
/// sessions' asks included), then working, then finished, which folds to one
/// line. A row names its workspace and goes to the agent's tab.
export function AgentsView({
  controller,
  snapshot,
  sections,
  closed,
  doneFolded,
  onFoldDone,
}: {
  controller: Controller;
  snapshot: Snapshot;
  sections: StatusSections;
  closed: ClosedAsks;
  doneFolded: boolean;
  onFoldDone: (folded: boolean) => void;
}) {
  const row = (placed: PlacedAgent) => (
    <AgentRow key={placed.agent.pane_id} controller={controller} snapshot={snapshot} agent={placed.agent} place={placed} />
  );
  const needsYou = sections.needsYou.length + closed.outcomes.length;
  if (needsYou + sections.working.length + sections.done.length === 0) {
    return <p className="empty">No agent is working, waiting on you or finished unseen.</p>;
  }
  return (
    <div className="agents-view">
      {needsYou > 0 && (
        <Section name="Needs you" count={needsYou} kind="needs-you">
          {sections.needsYou.map(row)}
          {closed.outcomes.map((outcome) => (
            <div key={outcome.id} className="agents-closed-row">
              <button
                className="card-row"
                title={`Closed session · ${repoName(outcome.home)}: ${outcome.note}\n${outcome.session ? "Click to resume the session" : "No session to resume"}`}
                disabled={!outcome.session}
                onClick={() => closed.onResume(outcome)}
              >
                <StatusMark status="blocked" note={outcome.note} />
                <span className="card-row-name">{outcome.note}</span>
                <span className="card-row-note card-row-place" style={{ "--hue": "var(--muted)" } as CSSProperties}>
                  {repoName(outcome.home)} · closed
                </span>
              </button>
              <button className="agents-closed-clear" title="Dealt with: stop listing it" aria-label="Clear" onClick={() => closed.onClear(outcome)}>
                ×
              </button>
            </div>
          ))}
        </Section>
      )}
      {sections.working.length > 0 && (
        <Section name="Working" count={sections.working.length} kind="working">
          {sections.working.map(row)}
        </Section>
      )}
      {sections.done.length > 0 && (
        <Section name="Done" count={sections.done.length} kind="done" folded={doneFolded} onFold={onFoldDone}>
          {sections.done.map(row)}
        </Section>
      )}
    </div>
  );
}

function Section({
  name,
  count,
  kind,
  folded = false,
  onFold,
  children,
}: {
  name: string;
  count: number;
  kind: string;
  folded?: boolean;
  onFold?: (folded: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className={`agents-status agents-${kind}`} aria-label={name}>
      {onFold ? (
        <button className="group-toggle agents-status-head" aria-expanded={!folded} title={folded ? `Show ${name.toLowerCase()}` : `Hide ${name.toLowerCase()}`} onClick={() => onFold(!folded)}>
          <ChevronIcon />
          <span>
            {name} <span className="agents-count">{count}</span>
          </span>
        </button>
      ) : (
        <h3 className="agents-status-head">
          {name} <span className="agents-count">{count}</span>
        </h3>
      )}
      {!folded && <div className="agents-rows">{children}</div>}
    </section>
  );
}
