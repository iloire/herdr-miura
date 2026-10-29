import { describe, expect, it } from "vitest";
import type { ClaudeUsage } from "../claudeUsage";
import { burn, contextLevel, formatTokens, type Minute, type SessionUsage, tokensSince, weighted, windowStart } from "../sessionUsage";

function minute(at: number, over: Partial<Minute> = {}): Minute {
  return { at, input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, ...over };
}

function session(minutes: Minute[]): SessionUsage {
  return { model: "claude-opus-5-5", context: 0, minutes };
}

describe("weighted", () => {
  it("prices each kind against fresh input, so cache reads count a tenth", () => {
    expect(weighted(minute(0, { input: 10, output: 10, cache_read: 1000, cache_write_5m: 100, cache_write_1h: 100 }))).toBe(
      10 + 50 + 100 + 125 + 200,
    );
  });
});

describe("tokensSince", () => {
  it("sums every session's minutes from the start on", () => {
    const total = tokensSince(
      [session([minute(60, { output: 1 }), minute(120, { output: 2 })]), session([minute(180, { cache_read: 5 })])],
      120,
    );
    expect(total).toEqual({ input: 0, output: 2, cache_read: 5, cache_write_5m: 0, cache_write_1h: 0 });
  });
});

describe("windowStart", () => {
  const now = Date.UTC(2026, 9, 29, 10, 0);
  it("starts five hours before the plan window resets", () => {
    const plan: ClaudeUsage = { plan: null, session: { percent: 6, resets_at: "2026-10-29T13:00:00Z" }, weekly: null };
    expect(windowStart(plan, now)).toBe(Date.UTC(2026, 9, 29, 8, 0) / 1000);
  });

  it("falls back to the last five hours without a reset to go by", () => {
    expect(windowStart(null, now)).toBe(Date.UTC(2026, 9, 29, 5, 0) / 1000);
    const passed: ClaudeUsage = { plan: null, session: { percent: 6, resets_at: "2026-10-29T09:00:00Z" }, weekly: null };
    expect(windowStart(passed, now)).toBe(Date.UTC(2026, 9, 29, 5, 0) / 1000);
  });
});

describe("burn", () => {
  it("buckets the last fifteen minutes oldest first, weighted", () => {
    const now = 10_000 * 60;
    const bars = burn([session([minute(now - 15 * 60, { input: 1 }), minute(now - 60, { output: 2 }), minute(now - 16 * 60, { input: 99 })])], now);
    expect(bars).toEqual([1, 0, 0, 0, 10]);
  });
});

describe("formatTokens", () => {
  it("rounds to what fits a header", () => {
    expect([950, 14_200, 999_999, 1_840_000].map(formatTokens)).toEqual(["950", "14k", "1.0M", "1.8M"]);
  });
});

describe("contextLevel", () => {
  it("marks a context from 150k as high and from 300k as over", () => {
    expect([149_999, 150_000, 299_999, 300_000, 900_000].map(contextLevel)).toEqual(["ok", "high", "high", "over", "over"]);
  });
});
