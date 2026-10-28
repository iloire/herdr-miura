import type { Controller } from "../app/controller";
import { agentCaption, agentName, agentsByWorkspace, blockedCount } from "../app/attention";
import type { Agent, Snapshot } from "../protocol";
import { StatusMark } from "./StatusMark";

export function Sidebar({ controller, snapshot }: { controller: Controller; snapshot: Snapshot | null }) {
  const workspaces = snapshot?.workspaces ?? [];
  const agents = snapshot ? agentsByWorkspace(snapshot) : new Map<string, Agent[]>();
  const caption = (agent: Agent) => (snapshot ? agentCaption(agent, snapshot) : null);
  return (
    <nav className="sidebar" aria-label="Workspaces">
      <header className="sidebar-head">
        <span>Workspaces</span>
        <button
          className="icon-button"
          title="New workspace"
          aria-label="New workspace"
          disabled={!snapshot}
          onClick={() => controller.run("new_workspace")}
        >
          +
        </button>
      </header>
      <ol className="workspace-list">
        {workspaces.map((workspace) => {
          const own = agents.get(workspace.workspace_id) ?? [];
          return (
            <li key={workspace.workspace_id}>
              <button
                className={`workspace status-${workspace.agent_status}`}
                aria-current={workspace.focused ? "true" : undefined}
                onClick={() => controller.request("workspace.focus", { workspace_id: workspace.workspace_id })}
              >
                <span className="workspace-number">{workspace.number}</span>
                <span className="workspace-text">
                  <span className="workspace-label">{workspace.label}</span>
                  {workspace.branch && (
                    <span className="workspace-branch">
                      {workspace.branch}
                      {workspace.git_ahead_behind && (workspace.git_ahead_behind[0] > 0 || workspace.git_ahead_behind[1] > 0)
                        ? ` ↑${workspace.git_ahead_behind[0]} ↓${workspace.git_ahead_behind[1]}`
                        : ""}
                    </span>
                  )}
                </span>
                <StatusMark status={workspace.agent_status} count={blockedCount(own) || undefined} />
              </button>
              {own.length > 0 && (
                <ul className="agent-list" aria-label={`Agents in ${workspace.label}`}>
                  {own.map((agent) => (
                    <AgentRow key={agent.pane_id} controller={controller} agent={agent} caption={caption(agent)} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {snapshot && workspaces.length === 0 && <p className="empty">No workspaces. Press + to open one.</p>}
    </nav>
  );
}

function AgentRow({ controller, agent, caption }: { controller: Controller; agent: Agent; caption: string | null }) {
  return (
    <li>
      <button
        className={`agent status-${agent.agent_status}`}
        aria-current={agent.focused ? "true" : undefined}
        onClick={() => controller.request("pane.focus", { pane_id: agent.pane_id })}
      >
        <StatusMark status={agent.agent_status} />
        <span className="agent-text">
          <span className="agent-name">{agentName(agent)}</span>
          {caption && <span className="agent-caption">{caption}</span>}
        </span>
      </button>
    </li>
  );
}
