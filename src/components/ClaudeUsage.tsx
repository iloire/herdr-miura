import { type ClaudeUsage as Usage, type UsageWindow, percent, resetTime, resetsIn } from "../app/claudeUsage";
import { ClaudeIcon } from "./icons";

/// Claude's 5-hour and weekly windows, as herdr-gpui's status bar shows them:
/// a meter, the share used and how long until the window resets.
export function ClaudeUsage({ usage, now }: { usage: Usage | null; now: number }) {
  if (!usage || (!usage.session && !usage.weekly)) return null;
  const windows = [
    { name: "5-hour", window: usage.session },
    { name: "Weekly", window: usage.weekly },
  ].filter((entry): entry is { name: string; window: UsageWindow } => entry.window !== null);
  const title = [
    `Claude${usage.plan ? ` ${usage.plan}` : ""} usage on this Mac`,
    ...windows.map(({ name, window }) => {
      const at = resetTime(window);
      const reset = at && at > now ? `, resets ${new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
      return `${name}: ${percent(window)}% used${reset}`;
    }),
  ].join("\n");
  return (
    <span className="claude-usage" title={title} aria-label={title}>
      <ClaudeIcon />
      {windows.map(({ name, window }) => {
        const used = percent(window);
        const left = resetsIn(window, now);
        const level = used >= 90 ? "high" : used >= 75 ? "warm" : "";
        return (
          <span key={name} className={`usage-window ${level}`}>
            <span className="usage-meter">
              <span style={{ width: `${used}%` }} />
            </span>
            {used}%{left && <span className="usage-reset">{left}</span>}
          </span>
        );
      })}
    </span>
  );
}
