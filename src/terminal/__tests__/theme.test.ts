import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, DIM, HIDDEN, REVERSED, cellColors, color, xtermPalette } from "../theme";

const theme = DEFAULT_THEME;

describe("color", () => {
  it("uses the fallback for the default color", () => {
    expect(color(0, 0x123456, theme)).toBe(0x123456);
    expect(color(17, 0x123456, theme)).toBe(0x123456);
  });

  it("maps named colors 1..=16 onto the ANSI palette", () => {
    expect(color(1, 0, theme)).toBe(theme.palette[0]);
    expect(color(16, 0, theme)).toBe(theme.palette[15]);
  });

  it("maps indexed and RGB colors", () => {
    expect(color(0x01000010, 0, theme)).toBe(theme.palette[16]);
    expect(color(0x02abcdef, 0, theme)).toBe(0xabcdef);
  });

  it("falls back on an unknown tag", () => {
    expect(color(0x03000000, 7, theme)).toBe(7);
  });
});

describe("cellColors", () => {
  it("swaps for reversed cells", () => {
    expect(cellColors(0, 0, REVERSED, theme)).toEqual([theme.background, theme.foreground]);
  });

  it("hides text in the background color", () => {
    const [fg, bg] = cellColors(0x02ffffff, 0x02000000, HIDDEN, theme);
    expect(fg).toBe(bg);
  });

  it("dims halfway toward the background", () => {
    expect(cellColors(0x02fefefe, 0x02000000, DIM, theme)[0]).toBe(0x7f7f7f);
  });
});

it("builds a 256-color palette", () => {
  const palette = xtermPalette(new Array(16).fill(0));
  expect(palette).toHaveLength(256);
  expect(palette[231]).toBe(0xffffff);
  expect(palette[232]).toBe(0x080808);
});
