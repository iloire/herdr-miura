import type { Controller } from "../app/controller";

/// Which daemon the window shows: this Mac's, or one host from
/// `~/.ssh/config`. Picking one replaces the connection.
export function HostPicker({ controller, host, hosts }: { controller: Controller; host: string | null; hosts: string[] }) {
  const choices = host && !hosts.includes(host) ? [host, ...hosts] : hosts;
  return (
    <select
      className="host-picker"
      aria-label="Host"
      value={host ?? ""}
      onFocus={() => controller.loadHosts()}
      onChange={(event) => void controller.connectTo(event.target.value || null)}
    >
      <option value="">This Mac</option>
      {choices.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}
