import { describe, expect, it } from "vitest";
import { BAR_WIDTH, authorHue, dayOf, filterCommits, groupByDay, initials, lineBar, rowTime } from "../commitRows";
import type { RecentCommit } from "../store";

const commit = (sha: string, time: number, subject = sha): RecentCommit => ({
  sha,
  short: sha.slice(0, 7),
  subject,
  author: "t",
  time,
  refs: [],
  additions: null,
  deletions: null,
});

// Thursday 12 November 2026, 15:00 local time.
const now = new Date(2026, 10, 12, 15, 0);
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime() / 1000;

describe("initials", () => {
  it("takes the first and last word's initials", () => {
    expect(initials("Ivan L. Loire")).toBe("IL");
    expect(initials("ada lovelace")).toBe("AL");
  });

  it("takes a lone word's first two letters", () => {
    expect(initials("claude")).toBe("CL");
    expect(initials("x")).toBe("X");
  });

  it("splits a machine or bot name on its punctuation", () => {
    expect(initials("dependabot[bot]")).toBe("DE");
    expect(initials("build-agent")).toBe("BA");
    expect(initials("mac.mini")).toBe("MM");
  });

  it("keeps letters beyond ASCII whole", () => {
    expect(initials("Élodie Ørsted")).toBe("ÉØ");
  });

  it("has a mark for a name with no letters", () => {
    expect(initials("")).toBe("?");
    expect(initials(" - ")).toBe("?");
  });
});

describe("authorHue", () => {
  it("is stable and in range", () => {
    expect(authorHue("ivan")).toBe(authorHue("ivan"));
    expect(authorHue("ivan")).not.toBe(authorHue("claude"));
    expect(authorHue("ivan")).toBeGreaterThanOrEqual(0);
    expect(authorHue("ivan")).toBeLessThan(360);
  });
});

describe("dayOf", () => {
  it("names today, yesterday, this week and older by calendar day", () => {
    expect(dayOf(at(12, 0), now)).toBe("Today");
    expect(dayOf(at(11, 23), now)).toBe("Yesterday");
    expect(dayOf(at(11, 0), now)).toBe("Yesterday");
    expect(dayOf(at(10), now)).toBe("This week");
    expect(dayOf(at(6), now)).toBe("This week");
    expect(dayOf(at(5), now)).toBe("Older");
  });

  it("counts a commit from a clock ahead of this one as today", () => {
    expect(dayOf(at(13), now)).toBe("Today");
  });
});

describe("groupByDay", () => {
  it("puts runs of commits under their day, in the list's order", () => {
    const groups = groupByDay([commit("a", at(12)), commit("b", at(12, 9)), commit("c", at(11)), commit("d", at(1))], now);
    expect(groups.map((group) => [group.day, group.commits.map((c) => c.sha)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Older", ["d"]],
    ]);
  });

  it("starts another run when an older commit sits above a newer one", () => {
    const groups = groupByDay([commit("a", at(12)), commit("b", at(1)), commit("c", at(12))], now);
    expect(groups.map((group) => group.day)).toEqual(["Today", "Older", "Today"]);
  });

  it("has no groups for no commits", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe("rowTime", () => {
  it("dates a row only as far as its separator does not", () => {
    const time = at(12, 9);
    expect(rowTime(time, "Today")).toBe(new Date(time * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(rowTime(time, "This week")).toBe(new Date(time * 1000).toLocaleDateString([], { weekday: "short" }));
    expect(rowTime(time, "Older")).toBe(new Date(time * 1000).toLocaleDateString([], { month: "short", day: "numeric" }));
  });
});

describe("filterCommits", () => {
  const commits = [commit("a", 1, "feat: Branch list"), commit("b", 2, "fix: stash parsing")];

  it("keeps subjects holding the text, ignoring case", () => {
    expect(filterCommits(commits, "BRANCH").map((c) => c.sha)).toEqual(["a"]);
    expect(filterCommits(commits, "  stash ").map((c) => c.sha)).toEqual(["b"]);
    expect(filterCommits(commits, "nothing")).toEqual([]);
  });

  it("keeps everything for a blank filter", () => {
    expect(filterCommits(commits, " ")).toBe(commits);
  });
});

describe("lineBar", () => {
  it("has no bar without counts or with nothing changed", () => {
    expect(lineBar(null, null)).toBeNull();
    expect(lineBar(0, 0)).toBeNull();
  });

  it("splits between added and removed", () => {
    const bar = lineBar(50, 50);
    expect(bar).not.toBeNull();
    expect(Math.abs(bar!.plus - bar!.minus)).toBeLessThanOrEqual(1);
    expect(lineBar(10, 0)!.minus).toBe(0);
  });

  it("grows with the size of the change, within bounds", () => {
    const length = (added: number) => {
      const bar = lineBar(added, 0)!;
      return bar.plus + bar.minus;
    };
    expect(length(1)).toBeGreaterThanOrEqual(3);
    expect(length(10)).toBeLessThan(length(100));
    expect(length(100)).toBeLessThan(length(999));
    expect(length(1_000_000)).toBe(BAR_WIDTH);
  });
});
