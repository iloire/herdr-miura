import { type CSSProperties, useState } from "react";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import { STATE_WORDS, startTeam, TEAM_FILE, type TeamState, teamRows } from "../app/team";
import type { Snapshot, Workspace } from "../protocol";
import { TeamDialog } from "./TeamDialog";

/// The focused workspace's team, under the workspace list: each role with a
/// letter in its hue and what it is doing. A started role's row focuses its
/// tab; one not started yet starts it. Nothing shows for a folder without a
/// team file. The header opens the team in full, with what each role's agent
/// file says.
export function TeamSection({
  controller,
  snapshot,
  workspace,
  directory,
  team,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace;
  /// The workspace's folder: where the team file is read and the tabs open.
  directory: string;
  team: TeamState;
}) {
  const [open, setOpen] = useState(false);
  if (team.phase === "none") return null;
  const dialog = open && (
    <TeamDialog
      controller={controller}
      snapshot={snapshot}
      workspace={workspace}
      directory={directory}
      team={team}
      onClose={() => setOpen(false)}
    />
  );
  const title = (count?: number) => (
    <button className="team-title" title="Show each role's agent, tools and prompt" onClick={() => setOpen(true)}>
      Team {count !== undefined && <span className="team-count">{count}</span>}
    </button>
  );
  if (team.phase === "invalid") {
    return (
      <section className="team" aria-label="Team">
        <header className="sidebar-head">{title()}</header>
        <p className="empty error">{team.error}</p>
        {dialog}
      </section>
    );
  }
  const rows = teamRows(team.members, workspace.workspace_id, snapshot);
  return (
    <section className="team" aria-label="Team">
      <header className="sidebar-head">{title(rows.length)}</header>
      <ul className="team-list">
        {rows.map(({ member, state, tabId }) => (
          <li key={member.role}>
            <button
              className={`team-member state-${state}`}
              style={{ "--hue": hueColor(member.role) } as CSSProperties}
              title={
                tabId
                  ? `Go to the ${member.role} tab (claude --agent ${member.agent})`
                  : `Start ${member.role}: claude --agent ${member.agent}, from ${TEAM_FILE}`
              }
              onClick={() =>
                tabId
                  ? controller.request("tab.focus", { tab_id: tabId })
                  : controller.act(startTeam(workspace.workspace_id, directory, [member]))
              }
            >
              <span className="team-avatar" aria-hidden="true">
                {member.role[0]?.toUpperCase()}
              </span>
              <span className="team-role">{member.role}</span>
              <span className="team-state">{STATE_WORDS[state]}</span>
            </button>
          </li>
        ))}
      </ul>
      {dialog}
    </section>
  );
}
