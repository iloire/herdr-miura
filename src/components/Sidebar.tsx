import type { Controller } from "../app/controller";
import { agentCaption, agentName, agentsByWorkspace, blockedCount } from "../app/attention";
import type { Agent, Snapshot } from "../protocol";
import { StatusMark } from "./StatusMark";

export function Sidebar({
  controller,
  snapshot,
  changedFiles,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  /// Files changed in each workspace's checkout, by workspace id; absent when none.
  changedFiles: Map<string, number>;
}) {
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
                  <WorkspaceGit
                    branch={workspace.branch}
                    aheadBehind={workspace.git_ahead_behind}
                    changed={changedFiles.get(workspace.workspace_id) ?? 0}
                  />
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

/// The branch line, as herdr-gpui's folder card has it: the branch, commits to
/// push and pull, and how many files are changed. Only what is non-zero shows.
function WorkspaceGit({
  branch,
  aheadBehind,
  changed,
}: {
  branch: string | null;
  aheadBehind: [number, number] | null;
  changed: number;
}) {
  const [ahead, behind] = aheadBehind ?? [0, 0];
  if (!branch && !changed) return null;
  return (
    <span className="workspace-branch">
      {branch && <span className="workspace-branch-name">{branch}</span>}
      {ahead > 0 && <span className="git-ahead" title={`${ahead} to push`}>↑{ahead}</span>}
      {behind > 0 && <span className="git-behind" title={`${behind} to pull`}>↓{behind}</span>}
      {changed > 0 && (
        <span className="git-changed" title={`${changed} changed ${changed === 1 ? "file" : "files"}`}>
          ±{changed}
        </span>
      )}
    </span>
  );
}
