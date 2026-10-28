import type { Controller, State } from "../app/controller";
import { shortcutLabel } from "../terminal/keys";
import type { ListeningPort } from "../app/ports";
import { HostPicker } from "./HostPicker";
import { Ports } from "./Ports";

/// Connection state first, so an old local error never hides a disconnect.
export function StatusBar({
  controller,
  state,
  workspace,
  ports,
}: {
  controller: Controller;
  state: State;
  /// The focused workspace's label, shown beside a dot in its hue.
  workspace?: string;
  /// The focused workspace's listening ports.
  ports: ListeningPort[];
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
      {notice && status.phase === "connected" && <span className="notice">{notice}</span>}
      <span className="spacer" />
      {workspace && <span className="status-workspace">{workspace}</span>}
      <Ports ports={ports} />
      {palette && <span className="hint">{shortcutLabel(palette)} commands</span>}
    </footer>
  );
}
