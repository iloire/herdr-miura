import { describe, expect, it } from "vitest";
import { elapsed, paceNote, percent, resetsIn, SESSION_MS, usageLevel } from "../claudeUsage";

const now = Date.parse("2026-10-29T12:00:00Z");

describe("resetsIn", () => {
  it("counts down in the two largest units", () => {
    expect(resetsIn({ percent: 9, resets_at: "2026-10-29T16:30:00Z" }, now)).toBe("4h 30m");
    expect(resetsIn({ percent: 34, resets_at: "2026-11-02T23:00:00+00:00" }, now)).toBe("4d 11h");
    expect(resetsIn({ percent: 1, resets_at: "2026-10-29T12:11:30Z" }, now)).toBe("12m");
  });

  it("reads epoch seconds as Anthropic may send them", () => {
    expect(resetsIn({ percent: 0, resets_at: now / 1000 + 3600 }, now)).toBe("1h 0m");
  });

  it("says nothing once the window has reset or when it is unknown", () => {
    expect(resetsIn({ percent: 0, resets_at: "2026-10-29T11:00:00Z" }, now)).toBeNull();
    expect(resetsIn({ percent: 0, resets_at: null }, now)).toBeNull();
    expect(resetsIn({ percent: 0, resets_at: "soon" }, now)).toBeNull();
  });
});

describe("percent", () => {
  it("rounds and clamps to the bar", () => {
    expect(percent({ percent: 34.5, resets_at: null })).toBe(35);
    expect(percent({ percent: 120, resets_at: null })).toBe(100);
  });
});

describe("elapsed", () => {
  it("is the share of the window gone by", () => {
    expect(elapsed({ percent: 0, resets_at: "2026-10-29T14:30:00Z" }, SESSION_MS, now)).toBe(0.5);
  });

  it("is unknown once the reset has passed", () => {
    expect(elapsed({ percent: 0, resets_at: "2026-10-29T11:00:00Z" }, SESSION_MS, now)).toBeNull();
    expect(elapsed({ percent: 0, resets_at: null }, SESSION_MS, now)).toBeNull();
  });
});

describe("paceNote", () => {
  const reset = "2026-10-29T14:30:00Z"; // Halfway through the window.

  it("projects the rate so far to the reset", () => {
    expect(paceNote({ percent: 20, resets_at: reset }, SESSION_MS, now)).toBe("On pace for 40% by the reset");
  });

  it("names when the limit comes if it comes first", () => {
    // 80 % in 2.5 h reaches 100 % at 3.125 h, 37.5 min from now.
    const at = new Date(now + 37.5 * 60_000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    expect(paceNote({ percent: 80, resets_at: reset }, SESSION_MS, now)).toBe(`On pace to hit the limit around ${at}`);
  });

  it("says so at the limit, even with no reset known", () => {
    expect(paceNote({ percent: 100, resets_at: null }, SESSION_MS, now)).toBe("Limit reached");
  });

  it("stays quiet when a window has barely begun", () => {
    expect(paceNote({ percent: 5, resets_at: "2026-10-29T16:50:00Z" }, SESSION_MS, now)).toBeNull();
  });
});

describe("usageLevel", () => {
  it("warns from 75 and alarms from 90", () => {
    expect([74, 75, 89, 90].map(usageLevel)).toEqual(["", "warm", "warm", "high"]);
  });
});
