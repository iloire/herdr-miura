import { useCallback, useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import type { Controller } from "../app/controller";
import { copyPath, openFolder, tildePath } from "../app/folder";
import { workspaceDirectory } from "../changes/counts";
import { agentCaption, agentName, agentsByWorkspace, blockedCount } from "../app/attention";
import type { Agent, Snapshot } from "../protocol";
import { ContextMenu, type MenuAt, type MenuItem } from "./ContextMenu";
import { BranchIcon, CodeIcon, CopyIcon, OpenIcon } from "./icons";
import { StatusMark } from "./StatusMark";

/// What a workspace's right-click offers for its folder, as herdr-gpui's folder menu does.
function folderMenu(controller: Controller, path: string): MenuItem[] {
  return [
    { label: "Open in VS Code", icon: <CodeIcon />, onSelect: () => controller.act(openFolder(path, "vs_code")) },
    {
      label: "Open in GitHub Desktop",
      icon: <BranchIcon />,
      onSelect: () => controller.act(openFolder(path, "github_desktop")),
    },
    { label: "Open Folder", icon: <OpenIcon />, onSelect: () => controller.act(openFolder(path, "files")) },
    { label: "Copy Path", icon: <CopyIcon />, onSelect: () => controller.act(copyPath(path)) },
  ];
}

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
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const home = useHome();
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
          const path = snapshot && workspaceDirectory(workspace, snapshot);
          return (
            <li key={workspace.workspace_id}>
              <button
                className={`workspace status-${workspace.agent_status}`}
                aria-current={workspace.focused ? "true" : undefined}
                onClick={() => controller.request("workspace.focus", { workspace_id: workspace.workspace_id })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (path) setMenu({ x: event.clientX, y: event.clientY, items: folderMenu(controller, path) });
                }}
              >
                <span className="workspace-text">
                  <span className="workspace-label">{workspace.label}</span>
                  {path && (
                    <span className="workspace-path" title={path}>
                      {tildePath(path, home)}
                    </span>
                  )}
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
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </nav>
  );
}

/// The home folder, read once, so paths under it show as `~`.
function useHome(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    homeDir().then(setHome, () => setHome(null));
  }, []);
  return home;
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
