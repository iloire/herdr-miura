import type { Agent, AgentStatus } from "../protocol";
import { formatMinutes } from "./time";

/// An agent's status and when the app first saw it, in epoch milliseconds.
export interface StatusSince {
  status: AgentStatus;
  since: number;
}

/// The snapshot carries no time for an agent, so the app keeps its own, by
/// pane: the old time while the status holds, `now` when it changes or the
/// pane is new, and nothing for a pane that is gone.
export function trackStatus(
  previous: Map<string, StatusSince>,
  agents: Pick<Agent, "pane_id" | "agent_status">[],
  now: number,
): Map<string, StatusSince> {
  const tracked = new Map<string, StatusSince>();
  for (const { pane_id, agent_status } of agents) {
    const seen = previous.get(pane_id);
    tracked.set(pane_id, seen?.status === agent_status ? seen : { status: agent_status, since: now });
  }
  return tracked;
}

/// How long a working or blocked agent has been so, from one minute up.
export function statusAge(entry: StatusSince | undefined, now: number): string | null {
  if (entry?.status !== "working" && entry?.status !== "blocked") return null;
  const minutes = Math.floor((now - entry.since) / 60_000);
  return minutes < 1 ? null : formatMinutes(minutes);
}
