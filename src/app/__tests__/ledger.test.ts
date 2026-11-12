import { describe, expect, it } from "vitest";
import { allParked, dayView, doneToday, isOpen, type LedgerEntry, outcomes, parkedFor, parkedPrompt, waitingClosed, waitingOnYou } from "../ledger";

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
    const list = outcomes({ entries: [entry("a", "2026-11-12T09:00:00Z", "left"), entry("b", "2026-11-12T10:00:00Z", "left")], resolutions: [] });
    expect(list.map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("a resolved left is no longer open", () => {
    const list = outcomes({
      entries: [entry("a", "2026-11-12T09:00:00Z", "left")],
      resolutions: [{ resolves: "a", how: "queued", at: "2026-11-12T09:30:00Z" }],
    });
    expect(isOpen(list[0])).toBe(false);
    expect(list[0].resolved?.how).toBe("queued");
  });

  it("a you is closed by a later entry from its session, a left is not", () => {
    const list = outcomes({
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
    const list = outcomes({ entries: [entry("n", "2026-11-12T09:00:00Z", "not-started", { session: "s2" })], resolutions: [] });
    expect(waitingOnYou(list).map((o) => o.id)).toEqual(["n"]);
  });

  it("done outcomes are never open", () => {
    const list = outcomes({ entries: [entry("v", "2026-11-12T09:00:00Z", "verified"), entry("u", "2026-11-12T09:00:00Z", "unverified")], resolutions: [] });
    expect(list.filter(isOpen)).toEqual([]);
  });
});

describe("parkedFor", () => {
  it("keeps only the open left entries of that checkout", () => {
    const list = outcomes({
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
    const list = outcomes({
      entries: [
        entry("old-done", yesterday, "verified"),
        entry("old-left", yesterday, "left", { home: "/other" }),
        entry("new", today, "verified"),
      ],
      resolutions: [],
    });
    const view = dayView(list, now);
    expect(view.map((g) => [g.home, g.outcomes.map((o) => o.id)])).toEqual([
      ["/r", ["new"]],
      ["/other", ["old-left"]],
    ]);
  });
});

describe("parkedPrompt", () => {
  it("stands on its own: the note, where it came from, and the transcript", () => {
    const [o] = outcomes({ entries: [entry("a", "2026-11-12T09:00:00Z", "left", { note: "Test on GTK", branch: "feat/x", session: "s1" })], resolutions: [] });
    expect(parkedPrompt(o)).toBe(
      "Test on GTK\n\nAn earlier session left this for later on branch `feat/x`, 2026-11-12T09:00:00Z.\nIts transcript is ~/.claude/projects/*/s1.jsonl, if you need what it knew.",
    );
  });
});

describe("waitingClosed", () => {
  it("keeps what waits on you from a session no tab holds", () => {
    const list = outcomes({
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
    const list = outcomes({
      entries: [
        entry("a", new Date(2026, 10, 12, 9, 0).toISOString(), "verified"),
        entry("b", new Date(2026, 10, 12, 10, 0).toISOString(), "unverified"),
        entry("c", new Date(2026, 10, 11, 23, 0).toISOString(), "verified"),
        entry("d", new Date(2026, 10, 12, 11, 0).toISOString(), "left"),
      ],
      resolutions: [],
    });
    expect(doneToday(list, now).map((o) => o.id)).toEqual(["b", "a"]);
  });
});
