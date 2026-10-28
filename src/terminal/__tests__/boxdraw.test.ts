import { expect, it } from "vitest";
import { boxBars } from "../boxdraw";

it("draws a vertical line the full height of its cell", () => {
  const bars = boxBars("│", 0, 20, 8, 20);
  expect(bars).not.toBeNull();
  const top = Math.min(...(bars ?? []).map((b) => b.y));
  const bottom = Math.max(...(bars ?? []).map((b) => b.y + b.height));
  expect([top, bottom]).toEqual([20, 40]);
});

it("joins a corner's arms at the center", () => {
  expect(boxBars("┌", 0, 0, 10, 20)).toEqual([
    { x: 5, y: 10, width: 1, height: 10 },
    { x: 5, y: 10, width: 5, height: 1 },
  ]);
});

it("leaves other characters to the font", () => {
  expect(boxBars("a", 0, 0, 8, 20)).toBeNull();
  expect(boxBars("═", 0, 0, 8, 20)).toBeNull();
});
