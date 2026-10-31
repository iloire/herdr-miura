import { useRef } from "react";
import { type StatusSince, statusAge, trackStatus } from "../app/agentAge";
import { agentTitle, loopTag, verifiedDone } from "../app/attention";
import type { ClaudeUsage } from "../app/claudeUsage";
import type { TabGit } from "../app/gitLine";
import { type ListeningPort, tabPorts } from "../app/ports";
import {
  burn,
  contextLevel,
  contextTitle,
  formatTokens,
  quietAge,
  quietTitle,
  type SessionUsage,
  sessionOf,
  shortModel,
  spendTitle,
  tokensSince,
  weighted,
  windowStart,
} from "../app/sessionUsage";
import { type Item, title } from "../app/queue";
import type { Controller } from "../app/controller";
import { type SharedCheckout, sharedTitle } from "../app/sharedCheckout";
import type { StrayPath } from "../app/workspaceRoot";
import type { Agent, Snapshot } from "../protocol";
import { GitAhead, GitBehind, GitChanged } from "./GitCounts";
import { BranchIcon, FolderIcon, LibraryIcon, QueueIcon } from "./icons";
import { Ports } from "./Ports";
import { StatusMark } from "./StatusMark";

/// Weighted tokens per bar below which the burn chart does not scale up, so
/// a quiet session reads as flat rather than as a full bar of very little.
const BURN_FLOOR = 50_000;

/// Characters of a branch name kept however tight the strip gets.
const BRANCH_FLOOR = 12;

/// Characters of a path kept however tight the strip gets.
const STRAY_FLOOR = 16;

const AGE_TITLE = "Time in this status, counted from when the app first saw it, so it restarts with the app";

/// A strip over the focused tab's terminal, carrying what the terminal does not
/// show, on two lines: the tab and its checkout, then its agents. It is always
/// both, even with no agent, as a height that came and went would resize the
/// terminal under whatever runs there. First, for a tab the queue opened, that it did: the tab itself looks
/// like any other. Then what makes a new prompt risky: a warning when other
/// agents can write in this checkout, and a rebase, merge or cherry-pick under
/// way or files in conflict. Then where the focused pane is, when that is not
/// the workspace's root, to catch an agent working in the wrong place. Then the
/// Git state of its checkout, which the sidebar cannot give: tabs of a workspace
/// can sit in different worktrees. Then the ports of the servers started in this
/// tab, each opening its page. At the first line's right end the prompt library,
/// whose prompts go to this tab's agent. The second line holds what matters about
/// each of its agents at all times: status, time in it, how long it has been quiet
/// when that is long, model, context, spend this plan window, the last fifteen
/// minutes' burn, a loop's next tick, and its title, or its latest prompt when it
/// has none. What is only sometimes true shows only then. On a tight first line
/// the warning and the Git state outlast the rest; on a tight second one the titles
/// give way first.
export function TabHeader({
  controller,
  snapshot,
  usages,
  plan,
  git,
  shared,
  stray,
  ports,
  queued,
  library,
}: {
  controller: Controller;
  snapshot: Snapshot | null;
  usages: Map<string, SessionUsage | null>;
  plan: ClaudeUsage | null;
  /// The focused pane's checkout, null with nothing to say.
  git: TabGit | null;
  /// Other agents that can write in the focused pane's checkout.
  shared: SharedCheckout | null;
  /// Where the focused pane is, when that is not the workspace's root.
  stray: StrayPath | null;
  /// The focused workspace's listening ports.
  ports: ListeningPort[];
  /// The queued prompt this tab holds, where it stands in its queue, and what follows it.
  queued: { item: Item; place: { position: number; total: number } | null; next: Item | null } | null;
  /// The prompt library's palette is open.
  library: boolean;
}) {
  // Every agent's, not just this tab's, so a background tab has the right time
  // when it comes up. No snapshot means reconnecting, which is not every agent
  // leaving. App's polls redraw the strip, its 15 s session reads whenever a
  // session has usage and its minute poll otherwise, so no timer is needed.
  const statuses = useRef(new Map<string, StatusSince>());
  const now = Date.now();
  if (snapshot) statuses.current = trackStatus(statuses.current, snapshot.agents, now);
  if (!snapshot?.focused_tab_id) return null;
  const agents = snapshot.agents.filter((agent) => agent.tab_id === snapshot.focused_tab_id);
  const since = windowStart(plan, now);
  return (
    <div className="tab-header" aria-label="This tab's checkout, servers and agents">
      <div className="tab-line">
        {queued && (
          <span className="tab-origin" title={queued.item.prompt}>
            <QueueIcon />
            <span className="tab-origin-text">
              From queue #{queued.item.n}
              {queued.place && ` · ${queued.place.position} of ${queued.place.total}`}
            </span>
          </span>
        )}
        {shared && (
          <span className="tab-shared" title={sharedTitle(shared)}>
            ⚠ {shared.count} agents here
          </span>
        )}
        {git && <GitUnderWay git={git} />}
        {stray && <StrayFacts stray={stray} />}
        {git && <GitFacts git={git} />}
        <Ports ports={tabPorts(ports, snapshot.panes, snapshot.focused_tab_id)} />
        {queued?.next && <span className="tab-queue">next: {title(queued.next.prompt, 40)}</span>}
        <button
          className="panel-toggle library-toggle"
          title="Prompt library (⌘⇧L)"
          aria-label="Prompt library"
          aria-pressed={library}
          onClick={() => controller.run("prompt_library")}
        >
          <LibraryIcon />
        </button>
      </div>
      <div className="tab-line">
        {agents.map((agent) => (
          <AgentFacts
            key={agent.pane_id}
            agent={agent}
            age={statusAge(statuses.current.get(agent.pane_id), now)}
            quiet={quietAge(usages.get(sessionOf(agent) ?? "") ?? null, statuses.current.get(agent.pane_id), now)}
            usage={usages.get(sessionOf(agent) ?? "") ?? null}
            since={since}
            now={Math.floor(now / 1000)}
          />
        ))}
      </div>
    </div>
  );
}

function StrayFacts({ stray }: { stray: StrayPath }) {
  return (
    <span
      className="tab-stray"
      title={stray.full}
      style={{ minWidth: `calc(16px + ${Math.min(stray.short.length, STRAY_FLOOR)}ch)` }}
    >
      <FolderIcon />
      <span className="tab-stray-path">{stray.short}</span>
    </span>
  );
}

/// A rebase, merge or cherry-pick under way, and conflicts. Ahead of the path
/// and the branch, whose floors would otherwise push them off a tight strip.
function GitUnderWay({ git }: { git: TabGit }) {
  if (!git.operation && git.conflicts === 0) return null;
  return (
    <span className="tab-git">
      {git.operation && (
        <span className="tab-git-operation" title="Under way in this checkout: a new prompt would land in the middle of it">
          {git.operation}
        </span>
      )}
      {git.conflicts > 0 && (
        <span className="tab-git-conflicts" title="Files with unresolved conflicts">
          {git.conflicts} {git.conflicts === 1 ? "conflict" : "conflicts"}
        </span>
      )}
    </span>
  );
}

function GitFacts({ git }: { git: TabGit }) {
  return (
    <span className="tab-git">
      {git.branch && (
        <span
          className="tab-git-branch"
          title={git.branch}
          style={{ minWidth: `calc(16px + ${Math.min(git.branch.length, BRANCH_FLOOR)}ch)` }}
        >
          <BranchIcon />
          <span className="tab-git-name">{git.branch}</span>
        </span>
      )}
      <GitChanged count={git.changed} />
      <GitAhead count={git.ahead} />
      <GitBehind count={git.behind} />
      {git.unmerged && (
        <span className="tab-git-unmerged" title={`Commits ${git.unmerged.base} does not have`}>
          {git.unmerged.count} unmerged
        </span>
      )}
    </span>
  );
}

function AgentFacts({
  agent,
  age,
  quiet,
  usage,
  since,
  now,
}: {
  agent: Agent;
  age: string | null;
  quiet: string | null;
  usage: SessionUsage | null;
  since: number;
  now: number;
}) {
  const loop = loopTag(agent);
  const spent = usage && tokensSince([usage], since);
  const title = agentTitle(agent);
  const prompt = title ? null : (usage?.prompt ?? null);
  return (
    <>
      <span className="tab-agent">
        <StatusMark status={agent.agent_status} verified={verifiedDone(agent)} />
        <span
          className="tab-agent-name"
          title={usage ? undefined : "Token use shows once a Claude Code hook reports this session, at its next prompt"}
        >
          {agent.display_agent ?? agent.agent ?? "agent"}
          {usage?.model && <span className="tab-agent-model"> · {shortModel(usage.model)}</span>}
        </span>
        {age && (
          <span className={`tab-fact age-${agent.agent_status}`} title={AGE_TITLE}>
            {agent.agent_status} <b>{age}</b>
          </span>
        )}
        {quiet && (
          <span className="tab-fact tab-quiet" title={quietTitle(quiet)}>
            quiet <b>{quiet}</b>
          </span>
        )}
        {usage && spent && (
          <>
            <span className={`tab-fact ctx-${contextLevel(usage.context)}`} title={contextTitle(usage.context)}>
              ctx <b>{formatTokens(usage.context)}</b>
            </span>
            <span className="tab-fact" title={spendTitle(spent, since)}>
              5h <b>{formatTokens(weighted(spent))}</b>
            </span>
            <Burn bars={burn([usage], now)} />
          </>
        )}
        {loop && <span className="tab-agent-loop">{loop}</span>}
      </span>
      {(title || prompt) && (
        <span className="tab-agent-title" title={title ?? prompt ?? undefined}>
          {title ?? `▸ ${prompt}`}
        </span>
      )}
    </>
  );
}

/// The last fifteen minutes' spend in three-minute bars, oldest first.
function Burn({ bars }: { bars: number[] }) {
  const top = Math.max(BURN_FLOOR, ...bars);
  const label = `Last 15 min: ${bars.map(formatTokens).join(" · ")} (weighted, 3 min each)`;
  return (
    <svg className="tab-burn" viewBox={`0 0 ${bars.length * 4} 12`} role="img" aria-label={label}>
      <title>{label}</title>
      {bars.map((bar, i) => {
        const height = bar > 0 ? Math.max(1, (bar / top) * 12) : 0.5;
        return <rect key={i} x={i * 4} y={12 - height} width="3" height={height} rx="0.5" />;
      })}
    </svg>
  );
}
