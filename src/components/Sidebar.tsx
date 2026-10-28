import type { Controller } from "../app/controller";
import type { AgentStatus, Snapshot } from "../protocol";

const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "Needs you",
  done: "Done",
  idle: "Idle",
  unknown: "",
  working: "Working",
};

export function StatusDot({ status }: { status: AgentStatus }) {
  if (status === "unknown") return null;
  return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

export function Sidebar({ controller, snapshot }: { controller: Controller; snapshot: Snapshot | null }) {
  const workspaces = snapshot?.workspaces ?? [];
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
        {workspaces.map((workspace) => (
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
              <StatusDot status={workspace.agent_status} />
            </button>
          </li>
        ))}
      </ol>
      {snapshot && workspaces.length === 0 && <p className="empty">No workspaces. Press + to open one.</p>}
    </nav>
  );
}
