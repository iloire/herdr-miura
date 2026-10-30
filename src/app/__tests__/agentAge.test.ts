import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../../protocol";
import { statusAge, type StatusSince, trackStatus } from "../agentAge";

const MINUTE = 60_000;

const agent = (pane_id: string, agent_status: AgentStatus) => ({ pane_id, agent_status });
const tracked = (entries: Record<string, StatusSince>) => new Map(Object.entries(entries));

describe("trackStatus", () => {
  it("starts a new pane at now", () => {
    expect(trackStatus(new Map(), [agent("p", "working")], 500)).toEqual(
      tracked({ p: { status: "working", since: 500 } }),
    );
  });

  it("keeps the old time while the status is unchanged", () => {
    const previous = tracked({ p: { status: "working", since: 100 } });
    expect(trackStatus(previous, [agent("p", "working")], 500)).toEqual(previous);
  });

  it("resets the time when the status changes", () => {
    const previous = tracked({ p: { status: "working", since: 100 } });
    expect(trackStatus(previous, [agent("p", "blocked")], 500)).toEqual(
      tracked({ p: { status: "blocked", since: 500 } }),
    );
  });

  it("drops panes that are gone and leaves the others alone", () => {
    const previous = tracked({
      gone: { status: "working", since: 100 },
      kept: { status: "blocked", since: 200 },
    });
    expect(trackStatus(previous, [agent("kept", "blocked")], 500)).toEqual(
      tracked({ kept: { status: "blocked", since: 200 } }),
    );
  });

  it("does not change the map it was given", () => {
    const previous = tracked({ p: { status: "working", since: 100 } });
    trackStatus(previous, [agent("p", "done")], 500);
    expect(previous).toEqual(tracked({ p: { status: "working", since: 100 } }));
  });
});

describe("statusAge", () => {
  const at = (status: AgentStatus) => ({ status, since: 0 });

  it("says nothing under a minute", () => {
    expect(statusAge(at("working"), MINUTE - 1)).toBeNull();
  });

  it("counts whole minutes from one minute up", () => {
    expect(statusAge(at("working"), MINUTE)).toBe("1m");
    expect(statusAge(at("blocked"), 12 * MINUTE + 59_999)).toBe("12m");
  });

  it("goes to hours past the hour", () => {
    expect(statusAge(at("working"), 125 * MINUTE)).toBe("2h 5m");
  });

  it("shows only working and blocked", () => {
    for (const status of ["idle", "done", "unknown"] as const) {
      expect(statusAge(at(status), 90 * MINUTE)).toBeNull();
    }
  });

  it("says nothing for a pane it has no entry for", () => {
    expect(statusAge(undefined, 90 * MINUTE)).toBeNull();
  });
});
