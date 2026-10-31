import { type CSSProperties, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AgentRead,
  agentIssues,
  agentPath,
  createAgent,
  openFile,
  parseAgentFile,
  promptPreview,
  useAgentFiles,
} from "../app/agentFile";
import type { Controller } from "../app/controller";
import { hueColor } from "../app/hue";
import { type MemberRow, STATE_WORDS, TEAM_FILE, type TeamState, teamRows } from "../app/team";
import type { Snapshot, Workspace } from "../protocol";
import { CodeIcon } from "./icons";

/// A workspace's team in full: a card per role with what its agent file says
/// (description, model, tools, skills, the start of its prompt) and what is
/// wrong with it, read again when the window comes back. Read-only: Edit and
/// Open team.json hand the files to VS Code, and a role without a file in the
/// repo can have one created.
export function TeamDialog({
  controller,
  snapshot,
  workspace,
  directory,
  team,
  onClose,
}: {
  controller: Controller;
  snapshot: Snapshot;
  workspace: Workspace;
  directory: string;
  team: Exclude<TeamState, { phase: "none" }>;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(0);
  const members = team.phase === "ready" ? team.members : [];
  const files = useAgentFiles(
    directory,
    members.map((member) => member.agent),
    version,
  );
  const rows = teamRows(members, workspace.workspace_id, snapshot);
  const create = (agent: string) =>
    controller.act(
      createAgent(directory, agent).then((path) => {
        setVersion((v) => v + 1);
        return openFile(directory, path);
      }),
    );
  return createPortal(
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette worktrees-dialog team-dialog"
        role="dialog"
        aria-labelledby="team-title"
        // A click on the text must leave focus inside, for Escape.
        tabIndex={-1}
        style={{ "--hue": hueColor(workspace.label) } as CSSProperties}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Team</span>
            <h2 id="team-title">{workspace.label}</h2>
            <p className={`worktrees-summary${team.phase === "invalid" ? " team-error" : ""}`}>
              {team.phase === "invalid" ? team.error : summary(rows, files)}
            </p>
          </div>
          <button className="team-open-file" onClick={() => controller.act(openFile(directory, TEAM_FILE))}>
            <CodeIcon />
            Open team.json
          </button>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <ul className="worktrees-list">
          {rows.map((row) => (
            <RoleCard
              key={row.member.role}
              row={row}
              read={files.get(row.member.agent)}
              onEdit={() => controller.act(openFile(directory, agentPath(row.member.agent)))}
              onCreate={() => create(row.member.agent)}
            />
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

/// How many roles, how many running, and how many have a problem.
function summary(rows: MemberRow[], files: Map<string, AgentRead>): string {
  const running = rows.filter((row) => row.state !== "absent").length;
  const broken = rows.filter((row) => {
    const read = files.get(row.member.agent);
    return read && agentIssues(row.member, read).length > 0;
  }).length;
  const roles = rows.length === 1 ? "1 role" : `${rows.length} roles`;
  const problems = broken === 0 ? "" : ` · ${broken} with ${broken === 1 ? "a problem" : "problems"}`;
  return `${roles} · ${running} running${problems}`;
}

function RoleCard({
  row: { member, state },
  read,
  onEdit,
  onCreate,
}: {
  row: MemberRow;
  /// Undefined until the first read comes back.
  read: AgentRead | undefined;
  onEdit: () => void;
  onCreate: () => void;
}) {
  const parsed = read?.phase === "text" ? parseAgentFile(read.text) : null;
  const file = parsed && !("error" in parsed) ? parsed : null;
  const issues = read ? agentIssues(member, read) : [];
  const preview = file ? promptPreview(file.prompt) : "";
  return (
    <li
      className={`team-role-card${issues.length ? " broken" : ""}`}
      style={{ "--hue": hueColor(member.role) } as CSSProperties}
    >
      <div className="team-card-top">
        <span className="team-card-avatar" aria-hidden="true">
          {member.role[0]?.toUpperCase()}
        </span>
        <span className="team-card-name">
          <span className="worktree-name">{member.role}</span>
          {member.agent !== member.role && <span className="team-agent">--agent {member.agent}</span>}
        </span>
        <span className={`team-card-state state-${state}`}>{STATE_WORDS[state]}</span>
        {read?.phase === "missing" ? (
          <button className="team-card-action primary" title={`Write ${agentPath(member.agent)} and open it in VS Code`} onClick={onCreate}>
            <CodeIcon />
            Create from template
          </button>
        ) : (
          <button
            className="team-card-action"
            disabled={!read}
            title={`Open ${agentPath(member.agent)} in VS Code`}
            onClick={onEdit}
          >
            <CodeIcon />
            Edit
          </button>
        )}
      </div>
      {file?.description && <p className="team-description">{file.description}</p>}
      {file && (
        <div className="team-pills">
          {file.model && <span className="team-pill model">{file.model}</span>}
          {file.tools.length > 0 ? (
            file.tools.map((tool) => (
              <span key={`t:${tool}`} className="team-pill">
                {tool}
              </span>
            ))
          ) : (
            <span className="team-pill quiet" title="No tools field: the agent can use every tool">
              all tools
            </span>
          )}
          {file.skills.map((skill) => (
            <span key={`s:${skill}`} className="team-pill skill" title="Skill loaded at start">
              {skill}
            </span>
          ))}
        </div>
      )}
      {preview && <p className="team-prompt">{preview}</p>}
      {issues.map((issue) => (
        <p key={issue} className="team-issue" role="note">
          {issue}
        </p>
      ))}
    </li>
  );
}
