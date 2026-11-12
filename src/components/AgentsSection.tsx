import { type CSSProperties, useRef, useState } from "react";
import { type AgentsPanel, clampAgentsHeight, loadAgentsPanel, saveAgentsPanel } from "../app/agentsPanel";
import type { Controller } from "../app/controller";
import { type Outcome, repoName } from "../app/ledger";
import type { Agent, Snapshot } from "../protocol";
import { AgentRow } from "./CardDetails";
import { ChevronIcon } from "./icons";
import { StatusMark } from "./StatusMark";

const KEY_STEP = 16;

/// The active agents of one workspace, under its name, in its card's color.
export interface AgentGroup {
  workspaceId: string;
  label: string;
  hue: string;
  agents: Agent[];
}

/// Every agent that is working, waiting on you or finished unseen, grouped by
/// workspace in the sidebar's order, folded groups included: with many
/// workspaces the cards no longer show at a glance who is working. A row goes
/// to the agent's tab. Nothing shows when no agent is active. Its top edge
/// drags to make it taller or shorter, and its head folds it to one line.
/// What waits on you from a session no tab holds any more, from the outcome
/// ledger: a row resumes the session, its × says it was dealt with.
export interface ClosedAsks {
  outcomes: Outcome[];
  onResume: (outcome: Outcome) => void;
  onClear: (outcome: Outcome) => void;
}

export function AgentsSection({
  controller,
  snapshot,
  groups,
  closed,
}: {
  controller: Controller;
  snapshot: Snapshot;
  groups: AgentGroup[];
  closed: ClosedAsks;
}) {
  const [panel, setPanel] = useState(loadAgentsPanel);
  const section = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number; room: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  if (groups.length === 0 && closed.outcomes.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.agents.length, 0) + closed.outcomes.length;
  const commit = (next: AgentsPanel) => {
    setPanel(next);
    saveAgentsPanel(next);
  };
  // The height the workspace list and this section share between them.
  const room = () => {
    const list = section.current?.parentElement?.querySelector(".workspace-list");
    if (!section.current || !list) return 0;
    return section.current.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("resizing-rows");
  };
  const style: CSSProperties | undefined = !panel.folded && panel.height !== null ? { height: panel.height } : undefined;
  return (
    <section
      ref={section}
      className={["agents", panel.folded && "folded", !panel.folded && panel.height !== null && "sized"].filter(Boolean).join(" ")}
      style={style}
      aria-label="Agents"
    >
      {!panel.folded && (
        <div
          className={`agents-resizer ${dragging ? "dragging" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize agents"
          tabIndex={0}
          title="Drag to resize, double-click to reset"
          onPointerDown={(event) => {
            if (event.button !== 0 || !section.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const height = section.current.getBoundingClientRect().height;
            drag.current = { startY: event.clientY, startHeight: height, room: room(), height };
            setDragging(true);
            document.body.classList.add("resizing-rows");
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            // The section sits at the foot: dragging its top edge up makes it taller.
            drag.current.height = clampAgentsHeight(drag.current.startHeight - (event.clientY - drag.current.startY), drag.current.room);
            setPanel({ ...panel, height: drag.current.height });
          }}
          onPointerUp={() => {
            if (!drag.current) return;
            if (drag.current.height !== drag.current.startHeight) commit({ ...panel, height: drag.current.height });
            endDrag();
          }}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => commit({ ...panel, height: null })}
          onKeyDown={(event) => {
            const step = event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
            if (!step || !section.current) return;
            event.preventDefault();
            commit({ ...panel, height: clampAgentsHeight(section.current.getBoundingClientRect().height + step, room()) });
          }}
        />
      )}
      <header className="sidebar-head">
        <button
          className="group-toggle agents-toggle"
          aria-expanded={!panel.folded}
          title={panel.folded ? "Show agents" : "Hide agents"}
          onClick={() => commit({ ...panel, folded: !panel.folded })}
        >
          <ChevronIcon />
          <span>
            Agents <span className="agents-count">{total}</span>
          </span>
        </button>
      </header>
      {!panel.folded && (
        <ul className="agents-list">
          {groups.map((group) => (
            <li key={group.workspaceId} className="agents-group" style={{ "--hue": group.hue } as CSSProperties}>
              <span className="agents-workspace">{group.label}</span>
              {group.agents.map((agent) => (
                <AgentRow key={agent.pane_id} controller={controller} snapshot={snapshot} agent={agent} />
              ))}
            </li>
          ))}
          {closed.outcomes.length > 0 && (
            <li className="agents-group agents-closed">
              <span className="agents-workspace">Closed sessions</span>
              {closed.outcomes.map((outcome) => (
                <div key={outcome.id} className="agents-closed-row">
                  <button
                    className="card-row"
                    title={`${repoName(outcome.home)}: ${outcome.note}\n${outcome.session ? "Click to resume the session" : "No session to resume"}`}
                    disabled={!outcome.session}
                    onClick={() => closed.onResume(outcome)}
                  >
                    <StatusMark status="blocked" note={outcome.note} />
                    <span className="card-row-name">
                      {repoName(outcome.home)}: {outcome.note}
                    </span>
                  </button>
                  <button className="agents-closed-clear" title="Dealt with: stop listing it" aria-label="Clear" onClick={() => closed.onClear(outcome)}>
                    ×
                  </button>
                </div>
              ))}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
