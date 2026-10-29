import type { Controller, State } from "../app/controller";
import { shortcutLabel } from "../terminal/keys";
import type { ClaudeUsage as Usage } from "../app/claudeUsage";
import type { ListeningPort } from "../app/ports";
import { ClaudeUsage } from "./ClaudeUsage";
import { HostPicker } from "./HostPicker";
import { Ports } from "./Ports";
import { Worktrees } from "./Worktrees";
import type { Worktree } from "../changes/worktrees";

/// Connection state first, so an old local error never hides a disconnect.
export function StatusBar({
  controller,
  state,
  workspace,
  worktrees,
  ports,
  usage,
  now,
}: {
  controller: Controller;
  state: State;
  /// The focused workspace's label, shown beside a dot in its hue.
  workspace?: string;
  /// The focused workspace's linked worktrees.
  worktrees: Worktree[];
  /// The focused workspace's listening ports.
  ports: ListeningPort[];
  /// This Mac's Claude plan usage: the account's, so it sits with the
  /// app-wide half of the bar rather than the focused workspace's.
  usage: Usage | null;
  now: number;
}) {
  const { status, notice } = state;
  const palette = state.commands.find((command) => command.name === "command_palette")?.parsed[0];
  return (
    <footer className={`statusbar phase-${status.phase}`}>
      <HostPicker controller={controller} host={state.host} hosts={state.hosts} />
      <span className="connection">
        {status.phase === "connecting" && (state.host ? `Connecting to ${state.host}…` : "Connecting to Herdr…")}
        {status.phase === "connected" && `Herdr ${status.serverVersion}`}
        {status.phase === "disconnected" && `Disconnected: ${status.reason}`}
      </span>
      {status.phase === "disconnected" && (
        <button className="link-button" onClick={() => controller.run("reconnect")}>
          Reconnect
        </button>
      )}
      <ClaudeUsage usage={usage} now={now} />
      {notice && status.phase === "connected" && <span className="notice">{notice}</span>}
      <span className="spacer" />
      {workspace && <span className="status-workspace">{workspace}</span>}
      <Worktrees worktrees={worktrees} />
      <Ports ports={ports} />
      {palette && <span className="hint">{shortcutLabel(palette)} commands</span>}
    </footer>
  );
}
