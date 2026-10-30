import type { CSSProperties } from "react";
import { agentCountsByTab, agentRowName } from "../app/attention";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import type { Agent, Snapshot } from "../protocol";
import { StatusMark } from "./StatusMark";

/// Agents of one workspace, under its name, on the rail color of its card.
export interface AgentGroup {
  workspaceId: string;
  label: string;
  /// The name the rail's color comes from: a worktree takes its checkout's.
  railLabel: string;
  agents: Agent[];
}

/// Every running agent, under the workspace list, when `ui.sidebar_agents` is
/// on: a row for each with its status mark, grouped by workspace. A row focuses
/// the agent's tab. Nothing shows when no agent runs.
export function AgentsSection({ controller, snapshot, groups }: { controller: Controller; snapshot: Snapshot; groups: AgentGroup[] }) {
  if (groups.length === 0) return null;
  const counts = agentCountsByTab(snapshot);
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
          <li key={group.workspaceId} className="agents-group" style={{ "--rail": hueColor(group.railLabel) } as CSSProperties}>
            <span className="agents-workspace">{group.label}</span>
            <ul>
              {group.agents.map((agent) => {
                const name = agentRowName(agent, snapshot.tabs, counts);
                return (
                  <li key={agent.pane_id}>
                    <button
                      className="agent-row"
                      title={name}
                      aria-current={agent.focused ? "true" : undefined}
                      onClick={() => controller.request("tab.focus", { tab_id: agent.tab_id })}
                    >
                      <span className="agent-row-name">{name}</span>
                      <StatusMark status={agent.agent_status} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
