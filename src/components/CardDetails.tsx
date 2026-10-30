import { agentCountsByTab, agentRowName, attentionRows, wantsYou } from "../app/attention";
import type { Controller } from "../app/controller";
import type { ListeningPort } from "../app/ports";
import { canLand } from "../changes/land";
import { isPending, pendingFirst, type Worktree, worktreeName } from "../changes/worktrees";
import type { Agent, Snapshot, Workspace } from "../protocol";
import { GitChanged } from "./GitCounts";
import { PortList } from "./Ports";
import { StatusMark } from "./StatusMark";

/// An agent on a workspace card: its status, then its name, and why it wants
/// you if it does. A click goes to its tab.
function AgentRow({ controller, snapshot, agent }: { controller: Controller; snapshot: Snapshot; agent: Agent }) {
  const name = agentRowName(agent, snapshot.tabs, agentCountsByTab(snapshot));
  return (
    <button
      className="card-row"
      title={name}
      aria-current={agent.focused ? "true" : undefined}
      onClick={() => controller.request("tab.focus", { tab_id: agent.tab_id })}
    >
      <StatusMark status={agent.agent_status} />
      <span className="card-row-name">{name}</span>
      {wantsYou(agent) && <span className="card-row-note">{agent.agent_status === "blocked" ? "Needs you" : "Done"}</span>}
    </button>
  );
}

/// What a collapsed card still shows: the blocked agents, a few at most so a
/// bad moment cannot push the list down, then a way to the rest. Gone when none
/// is blocked: finished agents are only a count here, and rows once expanded.
export function AttentionRows({
  controller,
  snapshot,
  agents,
  onExpand,
}: {
  controller: Controller;
  snapshot: Snapshot;
  agents: Agent[];
  onExpand: () => void;
}) {
  const { rows, more } = attentionRows(agents);
  if (rows.length === 0) return null;
  return (
    <div className="card-rows">
      {rows.map((agent) => (
        <AgentRow key={agent.pane_id} controller={controller} snapshot={snapshot} agent={agent} />
      ))}
      {more > 0 && (
        <button className="card-row card-row-more" onClick={onExpand}>
          +{more} more
        </button>
      )}
    </div>
  );
}

/// A worktree on its checkout's card: what is pending in it, or that it landed.
/// A click goes to its workspace when one is open on it, else to the details.
/// Land sits beside the row, not in it: a button cannot hold a button.
function WorktreeRow({ worktree, onOpen, land }: { worktree: Worktree; onOpen: () => void; land: LandAction | null }) {
  const pending = isPending(worktree);
  const unmerged = worktree.unmerged ?? 0;
  const name = worktreeName(worktree);
  return (
    <div className="card-row-with-action">
      <button className="card-row" title={worktree.subject ?? undefined} onClick={onOpen}>
        <span className={`card-dot ${pending ? "pending" : ""}`} aria-hidden="true" />
        <span className="card-row-name card-row-branch">{name}</span>
        <span className="card-row-note">
          {unmerged > 0 && <span className="git-ahead" title={`${unmerged} unmerged`}>↑{unmerged}</span>}
          <GitChanged count={worktree.changed ?? 0} />
          {!pending && worktree.unmerged === 0 && "merged"}
        </span>
      </button>
      {land && canLand(worktree) && (
        <button
          className="sync-action"
          disabled={land.busy(worktree)}
          aria-label={`Land ${name}`}
          title={`Check, rebase onto ${worktree.main}, fast-forward it, then remove the worktree and branch`}
          onClick={() => land.start(worktree)}
        >
          Land
        </button>
      )}
    </div>
  );
}

/// What a card may do to land one of its worktrees; `null` on a remote host.
export interface LandAction {
  /// A land is under way in that worktree's repo.
  busy: (worktree: Worktree) => boolean;
  start: (worktree: Worktree) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="card-section-title">{title}</h3>
      {children}
    </section>
  );
}

/// What an expanded card shows beyond the collapsed one: only what cannot be
/// seen without going to that workspace. A section is gone when it has nothing.
export function CardDetails({
  controller,
  snapshot,
  agents,
  worktrees,
  ports,
  openOn,
  onOpenWorktrees,
  land,
}: {
  controller: Controller;
  snapshot: Snapshot;
  agents: Agent[];
  worktrees: Worktree[];
  ports: ListeningPort[];
  /// The workspace open on a worktree, when there is one.
  openOn: (worktree: Worktree) => Workspace | null;
  onOpenWorktrees: () => void;
  land: LandAction | null;
}) {
  if (worktrees.length + agents.length + ports.length === 0) return null;
  const goTo = (worktree: Worktree) => {
    const workspace = openOn(worktree);
    if (workspace) controller.request("workspace.focus", { workspace_id: workspace.workspace_id });
    else onOpenWorktrees();
  };
  return (
    <div className="card-details">
      {worktrees.length > 0 && (
        <Section title="Worktrees">
          {pendingFirst(worktrees).map((worktree) => (
            <WorktreeRow key={worktree.path} worktree={worktree} onOpen={() => goTo(worktree)} land={land} />
          ))}
        </Section>
      )}
      {agents.length > 0 && (
        <Section title="Agents">
          {agents.map((agent) => (
            <AgentRow key={agent.pane_id} controller={controller} snapshot={snapshot} agent={agent} />
          ))}
        </Section>
      )}
      {ports.length > 0 && (
        <Section title="Ports">
          <PortList ports={ports} />
        </Section>
      )}
    </div>
  );
}
