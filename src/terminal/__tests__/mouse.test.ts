import { describe, expect, it } from "vitest";
import { MAX_PASTE_BYTES, MAX_WHEEL_LINES, pasteEvents, wheelEvents } from "../mouse";

const lines = (events: ReturnType<typeof wheelEvents>) =>
  events.map((event) => ("Mouse" in event ? [event.Mouse.kind, event.Mouse.lines] : null));

describe("wheelEvents", () => {
  it("sends scrollback one event with the whole count", () => {
    expect(lines(wheelEvents(3, 0, 0, 0, false))).toEqual([["ScrollUp", 3]]);
  });

  it("sends an application one event per line", () => {
    expect(lines(wheelEvents(-2, 0, 0, 0, true))).toEqual([
      ["ScrollDown", 1],
      ["ScrollDown", 1],
    ]);
  });

  it("caps a flick", () => {
    expect(wheelEvents(1000, 0, 0, 0, true)).toHaveLength(MAX_WHEEL_LINES);
  });
});

it("refuses an oversized paste", () => {
  expect(pasteEvents("hi")).toEqual([{ Paste: "hi" }]);
  expect(pasteEvents("x".repeat(MAX_PASTE_BYTES + 1))).toEqual([]);
});
