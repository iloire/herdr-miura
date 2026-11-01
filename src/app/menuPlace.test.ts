import { describe, expect, it } from "vitest";
import { placeMenu } from "./menuPlace";

const view = { width: 1000, height: 600 };
const size = { width: 200, height: 300 };

describe("placeMenu", () => {
  it("stays at its anchor when it fits", () => {
    expect(placeMenu({ x: 100, y: 50 }, size, view)).toEqual({ left: 100, top: 50 });
  });

  it("is pushed back inside the window", () => {
    expect(placeMenu({ x: 950, y: 500 }, size, view)).toEqual({ left: 792, top: 292 });
  });

  it("flips to the parent's other side when a submenu runs out of room", () => {
    expect(placeMenu({ x: 900, y: 50, flipX: 700 }, size, view)).toEqual({ left: 500, top: 50 });
  });

  it("does not flip when the submenu fits", () => {
    expect(placeMenu({ x: 500, y: 50, flipX: 300 }, size, view)).toEqual({ left: 500, top: 50 });
  });

  it("stays inside the window when neither side has room", () => {
    expect(placeMenu({ x: 900, y: 50, flipX: 100 }, size, view)).toEqual({ left: 8, top: 50 });
  });
});
