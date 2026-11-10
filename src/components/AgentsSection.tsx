import type { CSSProperties } from "react";
import type { Controller } from "../app/controller";
import type { Agent, Snapshot } from "../protocol";
import { AgentRow } from "./CardDetails";

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
/// to the agent's tab. Nothing shows when no agent is active.
export function AgentsSection({ controller, snapshot, groups }: { controller: Controller; snapshot: Snapshot; groups: AgentGroup[] }) {
  if (groups.length === 0) return null;
  const total = groups.reduce((sum, group) => sum + group.agents.length, 0);
  return (
    <section className="agents" aria-label="Agents">
      <header className="sidebar-head">
        <span>
          Agents <span className="agents-count">{total}</span>
        </span>
      </header>
      <ul className="agents-list">
        {groups.map((group) => (
          <li key={group.workspaceId} className="agents-group" style={{ "--hue": group.hue } as CSSProperties}>
            <span className="agents-workspace">{group.label}</span>
            {group.agents.map((agent) => (
              <AgentRow key={agent.pane_id} controller={controller} snapshot={snapshot} agent={agent} />
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
