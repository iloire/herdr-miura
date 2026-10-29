import { loopTag } from "../app/attention";
import type { ClaudeUsage } from "../app/claudeUsage";
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
import type { Agent, Snapshot } from "../protocol";
import { StatusMark } from "./StatusMark";

/// Weighted tokens per bar below which the burn chart does not scale up, so
/// a quiet session reads as flat rather than as a full bar of very little.
const BURN_FLOOR = 50_000;

/// A strip over the focused tab's terminal with what matters about each of
/// its agents at all times: status, model, context, spend this plan window,
/// the last fifteen minutes' burn, and a loop's next tick. Absent for a tab
/// without agents.
export function TabHeader({
  snapshot,
  usages,
  plan,
  queued,
}: {
  snapshot: Snapshot | null;
  usages: Map<string, SessionUsage | null>;
  plan: ClaudeUsage | null;
  /// The queued prompt this tab runs, where it stands in its queue, and what follows it.
  queued: { item: Item; position: number; total: number; next: Item | null } | null;
}) {
  const agents = snapshot?.agents.filter((agent) => agent.tab_id === snapshot.focused_tab_id) ?? [];
  if (agents.length === 0) return null;
  const now = Date.now();
  const since = windowStart(plan, now);
  return (
    <div className="tab-header" aria-label="This tab's agents">
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
    </div>
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
  return (
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
