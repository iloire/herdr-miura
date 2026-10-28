import { describe, expect, it } from "vitest";
import { hue, hueColor } from "../hue";

describe("hue", () => {
  it("matches herdr-gpui's slots for the same names", () => {
    expect(["herdr-gpui", "notes", "dotfiles", "lanzarote3d", "herdr-tauri"].map(hue)).toEqual([1, 6, 1, 2, 3]);
  });

  it("keeps every name on a red-to-cyan slot and spreads names across them", () => {
    const slots = new Set(Array.from({ length: 60 }, (_, i) => hue(`project-${i}`)));
    for (const slot of slots) expect([1, 2, 3, 4, 5, 6]).toContain(slot);
    expect(slots.size).toBe(6);
  });

  it("writes the slot's ANSI color as CSS", () => {
    expect(hueColor("notes")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
