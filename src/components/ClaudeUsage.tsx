import { type ClaudeUsage as Usage, type UsageWindow, percent, resetTime, resetsIn, usageLevel } from "../app/claudeUsage";
import { ClaudeIcon } from "./icons";

/// Claude's 5-hour and weekly windows, as herdr-gpui's status bar shows them:
/// a meter, the share used and how long until the window resets. Clicking
/// opens the details.
export function ClaudeUsage({ usage, now, onOpen }: { usage: Usage | null; now: number; onOpen: () => void }) {
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
    "Click for details",
  ].join("\n");
  return (
    <button className="claude-usage" title={title} aria-label={title} aria-haspopup="dialog" onClick={onOpen}>
      <ClaudeIcon />
      {windows.map(({ name, window }) => {
        const used = percent(window);
        const left = resetsIn(window, now);
        return (
          <span key={name} className={`usage-window ${usageLevel(used)}`}>
            <span className="usage-meter">
              <span style={{ width: `${used}%` }} />
            </span>
            {used}%{left && <span className="usage-reset">{left}</span>}
          </span>
        );
      })}
    </button>
  );
}
