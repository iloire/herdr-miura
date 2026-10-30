import { useEffect, useState } from "react";
import { agentTitle } from "../app/attention";
import {
  type ClaudeUsage,
  elapsed,
  paceNote,
  percent,
  resetTime,
  resetsIn,
  SESSION_MS,
  type UsageWindow,
  usageLevel,
  WEEK_MS,
} from "../app/claudeUsage";
import {
  burn,
  contextLevel,
  contextTitle,
  formatTokens,
  type SessionUsage,
  sessionOf,
  shortModel,
  tokensSince,
  weighted,
  windowStart,
} from "../app/sessionUsage";
import { formatMoment, relativeTime } from "../app/time";
import { dailySpend, type ProjectUsage, projectSpend, readUsageHistory, tokenMix } from "../app/usageHistory";
import type { Snapshot } from "../protocol";

/// How often the open dialog rereads the transcripts; only what was appended
/// since is read.
const HISTORY_POLL_MS = 30_000;
/// Fifteen-minute bars across the 5-hour window.
const WINDOW_BARS = 20;
const BAR_MINUTES = 15;
/// A bar in five carries a time on the axis, so the labels stay apart.
const LABEL_EVERY = 4;

type History = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; projects: ProjectUsage[] };

/// The week's use of every project, read while the dialog is open.
function useHistory(): History {
  const [history, setHistory] = useState<History>({ phase: "loading" });
  useEffect(() => {
    let reading = false;
    let live = true;
    const refresh = () => {
      if (reading) return;
      reading = true;
      readUsageHistory()
        .then((projects) => live && setHistory({ phase: "ready", projects }))
        .catch(() => live && setHistory((held) => (held.phase === "ready" ? held : { phase: "failed" })))
        .finally(() => (reading = false));
    };
    refresh();
    const timer = window.setInterval(refresh, HISTORY_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return history;
}

/// Everything known about this Mac's Claude use: the plan's limits as Anthropic
/// reports them, then what the transcripts here say the tokens went on.
export function UsageDialog({
  usage,
  now,
  snapshot,
  sessions,
  onClose,
}: {
  usage: ClaudeUsage | null;
  now: number;
  snapshot: Snapshot | null;
  sessions: Map<string, SessionUsage | null>;
  onClose: () => void;
}) {
  const history = useHistory();
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette usage-dialog"
        role="dialog"
        aria-labelledby="usage-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="worktrees-head">
          <div className="worktrees-heading">
            <span className="worktrees-eyebrow">Claude usage</span>
            <h2 id="usage-title">{usage?.plan ?? "Claude"}</h2>
            <p className="worktrees-summary">
              {usage?.read_at ? `Limits are for the whole account, read ${relativeTime(usage.read_at)}. ` : ""}
              Token charts count Claude Code on this Mac.
            </p>
          </div>
          <button autoFocus className="worktrees-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="usage-body">
          {usage && <Limits usage={usage} now={now} />}
          <Tokens usage={usage} now={now} history={history} snapshot={snapshot} sessions={sessions} />
        </div>
      </div>
    </div>
  );
}

function Limits({ usage, now }: { usage: ClaudeUsage; now: number }) {
  const rows = [
    usage.session && { name: "5-hour", window: usage.session, span: SESSION_MS },
    usage.weekly && { name: "Weekly", window: usage.weekly, span: WEEK_MS },
    ...usage.models.map((model) => ({ name: `Weekly ${model.name}`, window: model, span: WEEK_MS })),
  ].filter((row) => row !== null);
  const { surfaces, extra } = usage;
  return (
    <section className="usage-limits" aria-label="Plan limits">
      {rows.map((row) => (
        <Limit key={row.name} {...row} now={now} />
      ))}
      {(surfaces.length > 0 || extra) && (
        <p className="usage-facts">
          {surfaces.length > 0 && (
            <span>
              This week: {surfaces.map((share) => `${share.name} ${Math.round(share.percent)}%`).join(" · ")}
            </span>
          )}
          {extra && <span>Extra usage this month: {extraText(extra)}</span>}
        </p>
      )}
    </section>
  );
}

function extraText({ enabled, used, limit }: NonNullable<ClaudeUsage["extra"]>): string {
  if (!enabled) return "off";
  if (used && limit) return `${used} of ${limit}`;
  return used ?? "on";
}

/// The meter's fill is what the window has used and its tick how much of the
/// window has gone by, so fill past the tick is use running ahead of the clock.
function Limit({ name, window, span, now }: { name: string; window: UsageWindow; span: number; now: number }) {
  const used = percent(window);
  const passed = elapsed(window, span, now);
  const at = resetTime(window);
  const left = resetsIn(window, now);
  const note = paceNote(window, span, now);
  return (
    <div className={`usage-limit ${usageLevel(used)}`}>
      <span className="usage-limit-name">{name}</span>
      <span
        className="usage-gauge"
        role="meter"
        aria-label={`${name} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
      >
        <span className="usage-gauge-fill" style={{ width: `${used}%` }} />
        {passed !== null && (
          <span
            className="usage-gauge-time"
            style={{ left: `${passed * 100}%` }}
            title={`${Math.round(passed * 100)}% of this window has gone by`}
          />
        )}
      </span>
      <span className="usage-limit-percent">{used}%</span>
      <span className="usage-limit-reset">
        {at && left ? `Resets ${formatMoment(at)}, in ${left}` : "Reset time unknown"}
        {note && <span className="usage-limit-note">{note}</span>}
      </span>
    </div>
  );
}

function Tokens({
  usage,
  now,
  history,
  snapshot,
  sessions,
}: {
  usage: ClaudeUsage | null;
  now: number;
  history: History;
  snapshot: Snapshot | null;
  sessions: Map<string, SessionUsage | null>;
}) {
  if (history.phase === "loading") return <p className="usage-empty">Reading this week's Claude Code transcripts…</p>;
  if (history.phase === "failed") return <p className="usage-empty">Could not read the transcripts in ~/.claude/projects.</p>;
  const { projects } = history;
  const seconds = Math.floor(now / 1000);
  const start = windowStart(usage, now);
  const end = start + WINDOW_BARS * BAR_MINUTES * 60;
  const windowBars = burn(projects, end, WINDOW_BARS, BAR_MINUTES).map((spend, i) => {
    const at = start + i * BAR_MINUTES * 60;
    return {
      label: i % LABEL_EVERY === 0 ? clock(at) : "",
      detail: clock(at),
      spend,
      ahead: at > seconds,
    };
  });
  const days = dailySpend(projects, now);
  const weekStart = days[0].at;
  const dayBars = days.map((day, i) => ({
    label: i === days.length - 1 ? "Today" : weekday(day.at),
    detail: date(day.at),
    spend: day.spend,
    ahead: false,
  }));
  return (
    <>
      <div className="usage-pair">
        <section className="usage-section">
          <Chart title="This 5-hour window" bars={windowBars} grain="15 min" />
          <Mix tokens={tokensSince(projects, start)} />
        </section>
        <section className="usage-section">
          <Chart title="Last 7 days" bars={dayBars} grain="by day" />
          <Mix tokens={tokensSince(projects, weekStart)} />
        </section>
      </div>
      <div className="usage-pair">
        <Projects projects={projects} since={weekStart} />
        <Sessions snapshot={snapshot} sessions={sessions} since={start} />
      </div>
      <p className="usage-foot">
        Spend is counted in fresh-input tokens, each kind at its multiple, because raw counts are mostly cache reads at a
        tenth of the price. Anthropic does not publish how tokens map to the limits, so spend and percentages will not line
        up exactly.
      </p>
    </>
  );
}

function clock(at: number): string {
  return new Date(at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function weekday(at: number): string {
  return new Date(at * 1000).toLocaleDateString([], { weekday: "short" });
}

function date(at: number): string {
  return new Date(at * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

interface Bar {
  /// On the axis; empty for a bar that goes without.
  label: string;
  /// Beside its value, while hovered.
  detail: string;
  spend: number;
  /// Still to come in the window.
  ahead: boolean;
}

/// One series of bars with a line at the tallest. Hovering a bar reads it out
/// in the chart's heading rather than in a tooltip over the bars.
function Chart({ title, bars, grain }: { title: string; bars: Bar[]; grain: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const top = Math.max(...bars.map((bar) => bar.spend));
  const total = bars.reduce((sum, bar) => sum + bar.spend, 0);
  const shown = hovered === null ? null : bars[hovered];
  const label = `${title}, ${grain}: ${bars
    .filter((bar) => bar.spend > 0)
    .map((bar) => `${bar.detail} ${formatTokens(bar.spend)}`)
    .join(", ")}`;
  return (
    <>
      <h3 className="usage-heading">
        <span>{title}</span>
        <span className="usage-readout">
          {shown ? (
            `${shown.detail} · ${formatTokens(shown.spend)}`
          ) : (
            <>
              <b>{formatTokens(total)}</b> spent
            </>
          )}
        </span>
      </h3>
      <div className="usage-chart" role="img" aria-label={label} onMouseLeave={() => setHovered(null)}>
        {top > 0 && <span className="usage-chart-top">{formatTokens(top)}</span>}
        {bars.map((bar, i) => (
          <div
            key={bar.detail}
            className={`usage-column ${bar.ahead ? "ahead" : ""} ${hovered === i ? "hovered" : ""}`}
            onMouseEnter={() => setHovered(i)}
          >
            <span className="usage-bar" style={{ height: top > 0 ? `${(bar.spend / top) * 100}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="usage-axis" aria-hidden="true">
        {bars.map((bar) => (
          <span key={bar.detail}>{bar.label}</span>
        ))}
      </div>
    </>
  );
}

/// What a spend went on: one bar split by kind of token, with a labelled key.
function Mix({ tokens }: { tokens: Parameters<typeof tokenMix>[0] }) {
  const parts = tokenMix(tokens);
  if (weighted(tokens) === 0) return null;
  return (
    <>
      <div className="usage-mix" aria-hidden="true">
        {parts
          .filter((part) => part.spend > 0)
          .map((part) => (
            <span key={part.kind} className={`mix-${part.kind}`} style={{ flexGrow: part.share }} />
          ))}
      </div>
      <ul className="usage-key">
        {parts.map((part) => (
          <li key={part.kind} title={`${formatTokens(part.tokens)} tokens ${part.rate} = ${formatTokens(part.spend)} spent`}>
            <span className={`usage-swatch mix-${part.kind}`} />
            {part.label}
            <span className="usage-key-value">{Math.round(part.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Projects({ projects, since }: { projects: ProjectUsage[]; since: number }) {
  const ranked = projectSpend(projects, since);
  const top = ranked[0]?.spend ?? 0;
  return (
    <section className="usage-section">
      <h3 className="usage-heading">
        <span>By project</span>
        <span className="usage-readout">last 7 days</span>
      </h3>
      {ranked.length === 0 && <p className="usage-none">No Claude Code use this week.</p>}
      <ul className="usage-rows">
        {ranked.map((project) => (
          <li key={project.name}>
            <span className="usage-row-name" title={project.name}>
              {project.name}
            </span>
            <span className="usage-row-track">
              <span style={{ width: `${(project.spend / top) * 100}%` }} />
            </span>
            <span className="usage-row-value">{formatTokens(project.spend)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/// The Claude sessions in panes now, by what they spent this window.
function Sessions({
  snapshot,
  sessions,
  since,
}: {
  snapshot: Snapshot | null;
  sessions: Map<string, SessionUsage | null>;
  since: number;
}) {
  const rows = (snapshot?.agents ?? [])
    .flatMap((agent) => {
      const id = sessionOf(agent);
      const session = id ? sessions.get(id) : null;
      if (!id || !session) return [];
      return [{ id, agent, session, spend: weighted(tokensSince([session], since)) }];
    })
    .filter((row, i, all) => all.findIndex((other) => other.id === row.id) === i)
    .sort((a, b) => b.spend - a.spend);
  return (
    <section className="usage-section">
      <h3 className="usage-heading">
        <span>Open sessions</span>
        <span className="usage-readout">this 5-hour window</span>
      </h3>
      {rows.length === 0 && <p className="usage-none">No Claude session is reporting from a pane.</p>}
      <ul className="usage-rows usage-sessions">
        {rows.map(({ id, agent, session, spend }) => {
          const name = agentTitle(agent) ?? agent.display_agent ?? agent.agent ?? "agent";
          return (
            <li key={id}>
              <span className="usage-row-name" title={name}>
                {name}
              </span>
              <span className="usage-row-model">{session.model && shortModel(session.model)}</span>
              <span className={`usage-row-context ctx-${contextLevel(session.context)}`} title={contextTitle(session.context)}>
                ctx {formatTokens(session.context)}
              </span>
              <span className="usage-row-value">{formatTokens(spend)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
