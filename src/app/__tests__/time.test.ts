import { describe, expect, it } from "vitest";
import { formatSpan } from "../time";

describe("formatSpan", () => {
  it("rounds down to whole minutes and says when there is not one", () => {
    expect(formatSpan(59_999)).toBe("<1m");
    expect(formatSpan(60_000)).toBe("1m");
    expect(formatSpan(22.9 * 60_000)).toBe("22m");
  });

  it("goes on to hours", () => {
    expect(formatSpan(65 * 60_000)).toBe("1h 5m");
  });
});
