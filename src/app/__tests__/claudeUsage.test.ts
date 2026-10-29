import { describe, expect, it } from "vitest";
import { percent, resetsIn } from "../claudeUsage";

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
