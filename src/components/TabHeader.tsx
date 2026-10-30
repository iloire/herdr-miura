import { agentTitle, loopTag } from "../app/attention";
import type { ClaudeUsage } from "../app/claudeUsage";
import type { TabGit } from "../app/gitLine";
import { type ListeningPort, tabPorts } from "../app/ports";
import {
  burn,
  contextLevel,
  contextTitle,
  formatTokens,
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
import type { StrayPath } from "../app/workspaceRoot";
import type { Agent, Snapshot } from "../protocol";
import { GitAhead, GitBehind, GitChanged } from "./GitCounts";
import { BranchIcon, FolderIcon, LibraryIcon } from "./icons";
import { Ports } from "./Ports";
import { StatusMark } from "./StatusMark";

/// Weighted tokens per bar below which the burn chart does not scale up, so
/// a quiet session reads as flat rather than as a full bar of very little.
const BURN_FLOOR = 50_000;

/// Characters of a branch name kept however tight the strip gets.
const BRANCH_FLOOR = 12;

/// Characters of a path kept however tight the strip gets.
const STRAY_FLOOR = 16;

/// A strip over the focused tab's terminal. At its left where the focused pane
/// is, when that is not the workspace's root, to catch an agent working in the
/// wrong place. Then the Git state of its checkout, which the sidebar cannot
/// give: tabs of a workspace can sit in different worktrees. Then the ports of
/// the servers started in this tab, each opening its page. Then what matters
/// about each of its agents at all times: status, model, context, spend this
/// plan window, the last fifteen minutes' burn, a loop's next tick, and its
/// title. At its right end the prompt library, whose prompts go to this tab's
/// agent; for a tab with nothing else to say the library is all it holds.
export function TabHeader({
  controller,
  snapshot,
  usages,
  plan,
  git,
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
  /// Where the focused pane is, when that is not the workspace's root.
  stray: StrayPath | null;
  /// The focused workspace's listening ports.
  ports: ListeningPort[];
  /// The queued prompt this tab runs, where it stands in its queue, and what follows it.
  queued: { item: Item; position: number; total: number; next: Item | null } | null;
  /// The prompt library's palette is open.
  library: boolean;
}) {
  if (!snapshot?.focused_tab_id) return null;
  const agents = snapshot.agents.filter((agent) => agent.tab_id === snapshot.focused_tab_id);
  const now = Date.now();
  const since = windowStart(plan, now);
  return (
    <div className="tab-header" aria-label="This tab's checkout, servers and agents">
      {stray && <StrayFacts stray={stray} />}
      {git && <GitFacts git={git} />}
      <Ports ports={tabPorts(ports, snapshot.panes, snapshot.focused_tab_id)} />
      {agents.map((agent) => (
        <AgentFacts
          key={agent.pane_id}
          agent={agent}
          usage={usages.get(sessionOf(agent) ?? "") ?? null}
          since={since}
          now={Math.floor(now / 1000)}
        />
      ))}
      {queued && (
        <span className="tab-queue" title={queued.item.prompt}>
          queue #{queued.item.n} · {queued.position} of {queued.total}
          {queued.next && <> · next: {title(queued.next.prompt, 40)}</>}
        </span>
      )}
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
  usage,
  since,
  now,
}: {
  agent: Agent;
  usage: SessionUsage | null;
  since: number;
  now: number;
}) {
  const loop = loopTag(agent);
  const spent = usage && tokensSince([usage], since);
  const title = agentTitle(agent);
  return (
    <>
      <span className="tab-agent">
        <StatusMark status={agent.agent_status} />
        <span
          className="tab-agent-name"
          title={usage ? undefined : "Token use shows once a Claude Code hook reports this session, at its next prompt"}
        >
          {agent.display_agent ?? agent.agent ?? "agent"}
          {usage?.model && <span className="tab-agent-model"> · {shortModel(usage.model)}</span>}
        </span>
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
      {title && (
        <span className="tab-agent-title" title={title}>
          {title}
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
