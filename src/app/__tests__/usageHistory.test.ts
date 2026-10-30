import { describe, expect, it } from "vitest";
import type { Minute } from "../sessionUsage";
import { dailySpend, projectSpend, tokenMix } from "../usageHistory";

function minute(at: number, output: number): Minute {
  return { at, input: 0, output, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
}

const seconds = (date: Date) => date.getTime() / 1000;

describe("dailySpend", () => {
  const now = new Date(2026, 9, 29, 15, 30).getTime();

  it("puts each bucket in its local calendar day, today last", () => {
    const days = dailySpend(
      [
        {
          minutes: [
            minute(seconds(new Date(2026, 9, 29, 0, 0)), 1),
            minute(seconds(new Date(2026, 9, 28, 23, 59)), 2),
            minute(seconds(new Date(2026, 9, 23, 0, 0)), 4),
          ],
        },
      ],
      now,
    );
    expect(days.map((day) => day.spend)).toEqual([20, 0, 0, 0, 0, 10, 5]);
    expect(days[6].at).toBe(seconds(new Date(2026, 9, 29)));
  });

  it("leaves out what falls before the first day", () => {
    const days = dailySpend([{ minutes: [minute(seconds(new Date(2026, 9, 22, 23, 59)), 1)] }], now);
    expect(days.every((day) => day.spend === 0)).toBe(true);
  });

  it("keeps calendar days across a clock change", () => {
    // Clocks go back in Europe on the 25th, a 25-hour day where they do.
    const days = dailySpend([], new Date(2026, 9, 26, 12).getTime());
    const dates = days.map((day) => new Date(day.at * 1000).getDate());
    expect(dates).toEqual([20, 21, 22, 23, 24, 25, 26]);
  });
});

describe("projectSpend", () => {
  const project = (name: string, output: number) => ({ name, minutes: [minute(100, output)] });

  it("ranks by spend from the start on and drops projects with none", () => {
    const ranked = projectSpend([project("small", 1), project("large", 2), { name: "old", minutes: [minute(10, 9)] }], 100);
    expect(ranked).toEqual([
      { name: "large", spend: 10 },
      { name: "small", spend: 5 },
    ]);
  });

  it("folds those past the limit into Other", () => {
    const ranked = projectSpend([project("a", 4), project("b", 3), project("c", 2), project("d", 1)], 0, 2);
    expect(ranked.map((p) => p.name)).toEqual(["a", "b", "Other"]);
    expect(ranked[2].spend).toBe(15);
  });
});

describe("tokenMix", () => {
  it("keeps a fixed order and joins the cache writes at their own prices", () => {
    const parts = tokenMix({ input: 0, output: 2, cache_read: 0, cache_write_5m: 4, cache_write_1h: 5 });
    expect(parts.map((part) => part.kind)).toEqual(["output", "cache-write", "input", "cache-read"]);
    expect(parts[1]).toMatchObject({ tokens: 9, spend: 15, share: 0.6 });
    expect(parts[0].share).toBe(0.4);
  });

  it("gives no shares to no spend", () => {
    const parts = tokenMix({ input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
    expect(parts.every((part) => part.share === 0)).toBe(true);
  });
});
