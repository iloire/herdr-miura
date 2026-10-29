import type { CSSProperties } from "react";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import { type Member, STATE_WORDS, startTeam, TEAM_FILE, type TeamState, teamRows } from "../app/team";
import type { Snapshot, Workspace } from "../protocol";

/// The focused workspace's team, under the workspace list: each role with a
/// letter in its hue and what it is doing. A started role's row focuses its
/// tab; one not started yet starts it, and Start starts every missing one.
/// Nothing shows for a folder without a team file.
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
  if (team.phase === "none") return null;
  if (team.phase === "invalid") {
    return (
      <section className="team" aria-label="Team">
        <header className="sidebar-head">
          <span>Team</span>
        </header>
        <p className="empty error">{team.error}</p>
      </section>
    );
  }
  const rows = teamRows(team.members, workspace.workspace_id, snapshot);
  const missing = rows.filter((row) => row.state === "absent").map((row) => row.member);
  const start = (members: Member[]) =>
    controller.act(startTeam(workspace.workspace_id, directory, members));
  return (
    <section className="team" aria-label="Team">
      <header className="sidebar-head">
        <span>
          Team <span className="team-count">{rows.length}</span>
        </span>
        {missing.length > 0 && (
          <button
            className="team-start"
            title={`Open a tab for ${missing.map((m) => m.role).join(", ")} and run claude --agent in each`}
            onClick={() => start(missing)}
          >
            Start {missing.length === rows.length ? "all" : missing.length}
          </button>
        )}
      </header>
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
                tabId ? controller.request("tab.focus", { tab_id: tabId }) : start([member])
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
    </section>
  );
}
