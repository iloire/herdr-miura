import { describe, expect, it } from "vitest";
import { allParked, dayView, doneToday, isOpen, type Ledger, type LedgerEntry, olderOpen, outcomes, parkedFor, parkedPrompt, waitingClosed, waitingOnYou } from "../ledger";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const fold = (ledger: Ledger, now = NOW) => outcomes(ledger, now);

const entry = (id: string, at: string, kind: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id,
  at,
  kind,
  note: `note ${id}`,
  cwd: "/r",
  home: "/r",
  branch: "main",
  head: "",
  session: "",
  workspace: "",
  pane: "",
  ...extra,
});

describe("outcomes", () => {
  it("lists newest first", () => {
    const list = fold({ entries: [entry("a", "2026-11-12T09:00:00Z", "left"), entry("b", "2026-11-12T10:00:00Z", "left")], resolutions: [] });
    expect(list.map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("a resolved left is no longer open", () => {
    const list = fold({
      entries: [entry("a", "2026-11-12T09:00:00Z", "left")],
      resolutions: [{ resolves: "a", how: "queued", at: "2026-11-12T09:30:00Z" }],
    });
    expect(isOpen(list[0])).toBe(false);
    expect(list[0].resolved?.how).toBe("queued");
  });

  it("a you is closed by a later entry from its session, a left is not", () => {
    const list = fold({
      entries: [
        entry("y", "2026-11-12T09:00:00Z", "you", { session: "s1" }),
        entry("l", "2026-11-12T09:01:00Z", "left", { session: "s1" }),
        entry("v", "2026-11-12T09:30:00Z", "verified", { session: "s1" }),
      ],
      resolutions: [],
    });
    expect(waitingOnYou(list)).toEqual([]);
    expect(allParked(list).map((o) => o.id)).toEqual(["l"]);
  });

  it("not-started waits on you like you does", () => {
    const list = fold({ entries: [entry("n", "2026-11-12T09:00:00Z", "not-started", { session: "s2" })], resolutions: [] });
    expect(waitingOnYou(list).map((o) => o.id)).toEqual(["n"]);
  });

  it("done outcomes are never open", () => {
    const list = fold({ entries: [entry("v", "2026-11-12T09:00:00Z", "verified"), entry("u", "2026-11-12T09:00:00Z", "unverified")], resolutions: [] });
    expect(list.filter(isOpen)).toEqual([]);
  });
});

describe("parkedFor", () => {
  it("keeps only the open left entries of that checkout", () => {
    const list = fold({
      entries: [entry("a", "2026-11-12T09:00:00Z", "left"), entry("b", "2026-11-12T09:00:00Z", "left", { home: "/other" }), entry("c", "2026-11-12T09:00:00Z", "you")],
      resolutions: [],
    });
    expect(parkedFor(list, "/r").map((o) => o.id)).toEqual(["a"]);
  });
});

describe("dayView", () => {
  it("shows today's entries and older open ones, grouped by repo", () => {
    const now = new Date(2026, 10, 12, 18, 0).getTime();
    const today = new Date(2026, 10, 12, 9, 0).toISOString();
    const yesterday = new Date(2026, 10, 11, 9, 0).toISOString();
    const list = fold({
      entries: [
        entry("old-done", yesterday, "verified"),
        entry("old-left", yesterday, "left", { home: "/other" }),
        entry("new", today, "verified"),
      ],
      resolutions: [],
    }, now);
    const view = dayView(list, now);
    expect(view.map((g) => [g.home, g.outcomes.map((o) => o.id)])).toEqual([
      ["/r", ["new"]],
      ["/other", ["old-left"]],
    ]);
  });
});

describe("parkedPrompt", () => {
  it("stands on its own: the note, where it came from, and the transcript", () => {
    const [o] = fold({ entries: [entry("a", "2026-11-12T09:00:00Z", "left", { note: "Test on GTK", branch: "feat/x", session: "s1" })], resolutions: [] });
    expect(parkedPrompt(o)).toBe(
      "Test on GTK\n\nAn earlier session left this for later on branch `feat/x`, 2026-11-12T09:00:00Z.\nIts transcript is ~/.claude/projects/*/s1.jsonl, if you need what it knew.",
    );
  });
});

describe("waitingClosed", () => {
  it("keeps what waits on you from a session no tab holds", () => {
    const list = fold({
      entries: [
        entry("live", "2026-11-12T09:00:00Z", "you", { session: "s1" }),
        entry("gone", "2026-11-12T09:00:00Z", "you", { session: "s2" }),
        entry("none", "2026-11-12T09:00:00Z", "you"),
      ],
      resolutions: [],
    });
    expect(waitingClosed(list, new Set(["s1"])).map((o) => o.id)).toEqual(["gone", "none"]);
  });
});

describe("doneToday", () => {
  it("counts verified and unverified since local midnight", () => {
    const now = new Date(2026, 10, 12, 18, 0).getTime();
    const list = fold({
      entries: [
        entry("a", new Date(2026, 10, 12, 9, 0).toISOString(), "verified"),
        entry("b", new Date(2026, 10, 12, 10, 0).toISOString(), "unverified"),
        entry("c", new Date(2026, 10, 11, 23, 0).toISOString(), "verified"),
        entry("d", new Date(2026, 10, 12, 11, 0).toISOString(), "left"),
      ],
      resolutions: [],
    }, now);
    expect(doneToday(list, now).map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("stale", () => {
  it("a parked note leaves the lists after 7 days, an ask after 2, and stays open", () => {
    const list = fold({
      entries: [
        entry("left-6d", "2026-11-06T19:00:00Z", "left"),
        entry("left-8d", "2026-11-04T18:00:00Z", "left"),
        entry("you-1d", "2026-11-11T12:00:00Z", "you", { session: "a" }),
        entry("you-3d", "2026-11-09T18:00:00Z", "you", { session: "b" }),
      ],
      resolutions: [],
    });
    const ids = (view: ReturnType<typeof dayView>) => view.flatMap((g) => g.outcomes.map((o) => o.id));
    expect(allParked(list).map((o) => o.id)).toEqual(["left-6d"]);
    expect(waitingOnYou(list).map((o) => o.id)).toEqual(["you-1d"]);
    expect(olderOpen(list).map((o) => o.id)).toEqual(["you-3d", "left-8d"]);
    expect(list.filter(isOpen)).toHaveLength(4);
    expect(ids(dayView(list, NOW))).toEqual(["you-1d", "left-6d"]);
    expect(ids(dayView(list, NOW, true))).toEqual(["you-1d", "you-3d", "left-6d", "left-8d"]);
  });
});
