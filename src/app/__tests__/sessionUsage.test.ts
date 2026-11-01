import { describe, expect, it } from "vitest";
import type { ClaudeUsage } from "../claudeUsage";
import { burn, contextLevel, formatTokens, type Minute, QUIET_AFTER_MS, quietAge, type SessionUsage, tokensSince, weighted, windowStart } from "../sessionUsage";

function minute(at: number, over: Partial<Minute> = {}): Minute {
  return { at, input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, ...over };
}

function session(minutes: Minute[]): SessionUsage {
  return { model: "claude-opus-5-5", context: 0, minutes, written_at: null, prompt: null, cwds: [] };
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

const EMPTY: ClaudeUsage = { plan: null, session: null, weekly: null, models: [], surfaces: [], extra: null, read_at: 0 };

describe("windowStart", () => {
  const now = Date.UTC(2026, 9, 29, 10, 0);
  it("starts five hours before the plan window resets", () => {
    const plan: ClaudeUsage = { ...EMPTY, session: { percent: 6, resets_at: "2026-10-29T13:00:00Z" } };
    expect(windowStart(plan, now)).toBe(Date.UTC(2026, 9, 29, 8, 0) / 1000);
  });

  it("falls back to the last five hours without a reset to go by", () => {
    expect(windowStart(null, now)).toBe(Date.UTC(2026, 9, 29, 5, 0) / 1000);
    const passed: ClaudeUsage = { ...EMPTY, session: { percent: 6, resets_at: "2026-10-29T09:00:00Z" } };
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

describe("quietAge", () => {
  const now = 1_800_000_000_000;
  const writtenAgo = (ms: number) => ({ ...session([]), written_at: (now - ms) / 1000 });
  const working = { status: "working", since: 0 } as const;

  it("shows nothing below the threshold and minutes from it", () => {
    expect(quietAge(writtenAgo(QUIET_AFTER_MS - 1000), working, now)).toBeNull();
    expect(quietAge(writtenAgo(QUIET_AFTER_MS), working, now)).toBe("5m");
    expect(quietAge(writtenAgo(6.9 * 60_000), working, now)).toBe("6m");
  });

  it("shows nothing unless working", () => {
    expect(quietAge(writtenAgo(3_600_000), { status: "blocked", since: 0 }, now)).toBeNull();
    expect(quietAge(writtenAgo(3_600_000), { status: "idle", since: 0 }, now)).toBeNull();
    expect(quietAge(writtenAgo(3_600_000), undefined, now)).toBeNull();
  });

  it("shows nothing without usage or a known write", () => {
    expect(quietAge(null, working, now)).toBeNull();
    expect(quietAge(session([]), working, now)).toBeNull();
  });

  it("counts from when work started, so a new prompt in an old session is not quiet", () => {
    const justStarted = { status: "working", since: now - 10_000 } as const;
    expect(quietAge(writtenAgo(3_600_000), justStarted, now)).toBeNull();
    const startedLongAgo = { status: "working", since: now - 8 * 60_000 } as const;
    expect(quietAge(writtenAgo(3_600_000), startedLongAgo, now)).toBe("8m");
  });

  it("shows nothing for a write stamped ahead of the clock", () => {
    expect(quietAge(writtenAgo(-60_000), working, now)).toBeNull();
  });
});
