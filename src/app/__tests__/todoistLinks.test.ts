import { describe, expect, it } from "vitest";
import { type LedgerEntry, outcomes } from "../ledger";
import { type LinksFile, linkedOutcomes, offer, offers, sinceMidnight, type TaskLink, toComment } from "../todoistLinks";

const NOW = Date.parse("2026-11-13T18:00:00Z");

const entry = (id: string, at: string, kind: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id,
  at,
  kind,
  note: `note ${id}`,
  cwd: "/r",
  home: "/r",
  branch: "main",
  head: "",
  session: "s1",
  workspace: "w1",
  pane: "w1:p1",
  ...extra,
});

const link = (task: string, at: string, pane = "w1:p1"): TaskLink => ({ task, title: `Task ${task}`, pane, head: null, at });

const linked = (entries: LedgerEntry[], file: LinksFile) => {
  const list = outcomes({ entries, resolutions: [] }, NOW);
  return { list, map: linkedOutcomes(list, file) };
};

describe("linkedOutcomes", () => {
  it("links a pane's outcomes after the link to its task, until one ends the work", () => {
    const { map } = linked(
      [
        entry("before", "2026-11-13T08:00:00Z", "verified"),
        entry("ask", "2026-11-13T10:00:00Z", "you"),
        entry("done", "2026-11-13T11:00:00Z", "verified"),
        entry("after", "2026-11-13T12:00:00Z", "left"),
        entry("other-pane", "2026-11-13T10:30:00Z", "verified", { pane: "w1:p2" }),
      ],
      { links: [link("t1", "2026-11-13T09:00:00Z")], written: [] },
    );
    expect([...map.keys()].sort()).toEqual(["ask", "done"]);
    expect(map.get("done")?.link.task).toBe("t1");
  });

  it("a later link on the same pane takes over", () => {
    const { map } = linked(
      [entry("a", "2026-11-13T10:00:00Z", "verified"), entry("b", "2026-11-13T12:00:00Z", "left")],
      { links: [link("t1", "2026-11-13T09:00:00Z"), link("t2", "2026-11-13T11:00:00Z")], written: [] },
    );
    expect(map.get("a")?.link.task).toBe("t1");
    expect(map.get("b")?.link.task).toBe("t2");
  });

  it("the first session claims the link, so a reused pane id does not match", () => {
    const { map } = linked(
      [entry("a", "2026-11-13T10:00:00Z", "you", { session: "s1" }), entry("b", "2026-11-13T11:00:00Z", "verified", { session: "s2" })],
      { links: [link("t1", "2026-11-13T09:00:00Z")], written: [] },
    );
    expect([...map.keys()]).toEqual(["a"]);
  });

  it("carries what was written back for each entry", () => {
    const { list, map } = linked([entry("a", "2026-11-13T10:00:00Z", "verified")], {
      links: [link("t1", "2026-11-13T09:00:00Z")],
      written: [{ entry: "a", task: "t1", did: "closed", at: "2026-11-13T10:05:00Z" }],
    });
    expect(map.get("a")?.written.has("closed")).toBe(true);
    expect(offer(list[0], map.get("a"))).toBeNull();
  });
});

describe("offers", () => {
  const file = { links: [link("t1", "2026-11-13T09:00:00Z"), link("t2", "2026-11-13T09:00:00Z", "w1:p2")], written: [] };

  it("offers to complete a verified done and to add a parked note, never an unverified one", () => {
    const { list, map } = linked(
      [entry("done", "2026-11-13T10:00:00Z", "verified"), entry("left", "2026-11-13T10:00:00Z", "left", { pane: "w1:p2", session: "s2" })],
      file,
    );
    const byId = (id: string) => list.find((o) => o.id === id)!;
    expect(offer(byId("done"), map.get("done"))).toBe("close");
    expect(offer(byId("left"), map.get("left"))).toBe("subtask");
    expect(offers(list, map, NOW).map((o) => o.id).sort()).toEqual(["done", "left"]);
    const { list: other, map: otherMap } = linked([entry("u", "2026-11-13T10:00:00Z", "unverified")], file);
    expect(offer(other[0], otherMap.get("u"))).toBeNull();
  });

  it("a resolved parked note, or yesterday's done, is not counted", () => {
    const list = outcomes(
      {
        entries: [entry("old", "2026-11-12T10:00:00Z", "verified"), entry("left", "2026-11-13T10:00:00Z", "left", { pane: "w1:p2", session: "s2" })],
        resolutions: [{ resolves: "left", how: "dismissed", at: "2026-11-13T11:00:00Z" }],
      },
      NOW,
    );
    const map = linkedOutcomes(list, { links: [link("t1", "2026-11-12T09:00:00Z"), link("t2", "2026-11-13T09:00:00Z", "w1:p2")], written: [] });
    expect(offers(list, map, NOW)).toEqual([]);
  });

  it("comments on a recent open ask once", () => {
    const entries = [entry("ask", "2026-11-13T10:00:00Z", "you"), entry("stale", "2026-11-10T10:00:00Z", "you", { pane: "w1:p2", session: "s2" })];
    const links = [link("t1", "2026-11-13T09:00:00Z"), link("t2", "2026-11-10T09:00:00Z", "w1:p2")];
    const first = linked(entries, { links, written: [] });
    expect(toComment(first.list, first.map).map((o) => o.id)).toEqual(["ask"]);
    const again = linked(entries, { links, written: [{ entry: "ask", task: "t1", did: "commented", at: "2026-11-13T10:01:00Z" }] });
    expect(toComment(again.list, again.map)).toEqual([]);
  });
});

describe("sinceMidnight", () => {
  it("spans the local day so far in whole UTC seconds", () => {
    const { since, until } = sinceMidnight(NOW + 123);
    expect(until).toBe("2026-11-13T18:00:00Z");
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(new Date(since).getHours()).toBe(0);
  });
});
