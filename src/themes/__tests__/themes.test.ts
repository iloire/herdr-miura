import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
import { DEFAULT_THEME } from "../../terminal/theme";
import { BUILTIN_NAMES, DEFAULT_THEME_NAME, builtinTheme, parseThemeName } from "../catalog";
import { TOKENS, chromeTokens, legible, mix } from "../chrome";
import { ink, ratio } from "../contrast";
import { FALLBACK_THEME, ThemeParseError, parseGhostty } from "../ghostty";

// Vitest blanks CSS imports, even `?raw`, so the stylesheet is read as a file.
const styles: string = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const hex = (token: string) => parseInt(token.slice(1), 16);

describe("parseGhostty", () => {
  it("reads colors and palette slots, skipping comments and other keys", () => {
    const theme = parseGhostty(
      [
        "# a comment",
        "",
        "palette = 0=#111111",
        "palette = 15 = #eeeeee",
        "background = #202020",
        "foreground = d0d0d0",
        "cursor-color = #ffcc00",
        "selection-background = #333333",
        "font-family = Menlo",
      ].join("\n"),
    );
    expect(theme.background).toBe(0x202020);
    expect(theme.foreground).toBe(0xd0d0d0);
    expect(theme.cursor).toBe(0xffcc00);
    expect(theme.palette[0]).toBe(0x111111);
    expect(theme.palette[15]).toBe(0xeeeeee);
    expect(theme.palette).toHaveLength(256);
  });

  it("fills a missing palette slot and cursor from herdr-gpui's defaults", () => {
    const theme = parseGhostty("palette = 1=#aa0000\nforeground = #c0c0c0\n");
    expect(theme.palette[1]).toBe(0xaa0000);
    expect(theme.palette[2]).toBe(FALLBACK_THEME.palette[2]);
    expect(theme.palette[200]).toBe(FALLBACK_THEME.palette[200]);
    expect(theme.background).toBe(FALLBACK_THEME.background);
    expect(theme.cursor).toBe(0xc0c0c0);
  });

  it("refuses a malformed line with its number", () => {
    for (const [text, line] of [
      ["background = #12345", 1],
      ["foreground = #ffffff\nbackground = red", 2],
      ["\n\npalette = 3", 3],
      ["palette = x=#ffffff", 1],
      ["palette = 256=#ffffff", 1],
    ] as const) {
      expect(() => parseGhostty(text)).toThrow(ThemeParseError);
      try {
        parseGhostty(text);
      } catch (error) {
        expect((error as ThemeParseError).line).toBe(line);
      }
    }
  });
});

describe("builtin themes", () => {
  it("ships a short list, Herdr Night first, each of which loads", () => {
    expect(BUILTIN_NAMES).toEqual([
      DEFAULT_THEME_NAME,
      "Catppuccin Latte",
      "Catppuccin Mocha",
      "Dracula",
      "GitHub Light Default",
      "Gruvbox Material Dark",
      "Nord",
      "TokyoNight",
    ]);
    for (const name of BUILTIN_NAMES) expect(builtinTheme(name)?.name).toBe(name);
    expect(builtinTheme("Nonexistent")).toBeUndefined();
  });

  it("keeps Herdr Night's chrome equal to styles.css's :root", () => {
    const night = builtinTheme(DEFAULT_THEME_NAME);
    expect(night?.terminal).toBe(DEFAULT_THEME);
    const root = styles.slice(styles.indexOf(":root {"), styles.indexOf("}"));
    for (const token of TOKENS) {
      const match = root.match(new RegExp(`--${token}: ([^;]+);`));
      expect(match?.[1], token).toBe(night?.chrome.tokens[token]);
    }
    expect(root).toContain("color-scheme: dark");
  });

  it("keeps everything written in the chrome readable in every theme", () => {
    for (const name of BUILTIN_NAMES) {
      const { terminal, chrome } = builtinTheme(name)!;
      const { tokens } = chrome;
      const words = ["text", "muted", "bright", "lantern", "working", "blocked", "done", "team"] as const;
      const hues = [1, 2, 3, 4, 5, 6].map((slot) => legible(terminal.palette[slot], tokens));
      for (const under of ["ink", "peat", "active"] as const) {
        const surface = hex(tokens[under]);
        for (const word of words) {
          expect(ratio(hex(tokens[word]), surface), `${name}: ${word} on ${under}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const color of hues) {
          expect(ratio(color, surface), `${name}: a hue on ${under}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(hex(tokens.faint), surface), `${name}: faint on ${under}`).toBeGreaterThanOrEqual(3);
      }
      // A solid button: the background's color on the fill.
      for (const fill of [...hues, hex(tokens.lantern), hex(tokens.blocked)]) {
        expect(ratio(hex(tokens.ink), fill), `${name}: words on a fill`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("chromeTokens", () => {
  it("derives a dark theme's chrome from its background and foreground", () => {
    const nord = builtinTheme("Nord")!.terminal;
    const { tokens, scheme } = chromeTokens(nord);
    expect(scheme).toBe("dark");
    expect(tokens.ink).toBe("#2e3440");
    expect(tokens.text).toBe("#d8dee9");
    expect(hex(tokens.peat)).toBe(mix(0x2e3440, 0xd8dee9, 2));
    expect(hex(tokens.gutter)).toBe(mix(0x2e3440, 0xd8dee9, 3));
    // Nord's green already reads on its chrome, so it is left as drawn; its
    // red falls below 4.5:1 on a selected row and is lifted, keeping its hue.
    expect(tokens.done).toBe("#a3be8c");
    expect(ratio(0xbf616a, hex(tokens.active))).toBeLessThan(4.5);
    expect(ratio(hex(tokens.blocked), hex(tokens.active))).toBeGreaterThanOrEqual(4.5);
  });

  it("derives a light theme's chrome and nudges pastels until they read", () => {
    const latte = builtinTheme("Catppuccin Latte")!.terminal;
    const { tokens, scheme } = chromeTokens(latte);
    expect(scheme).toBe("light");
    expect(tokens.ink).toBe("#eff1f5");
    // The cursor repeats the text, so the lantern is the palette's yellow,
    // which falls below 3:1 on the surface and is darkened until it reads.
    expect(ratio(0xdf8e1d, hex(tokens.peat))).toBeLessThan(3);
    expect(tokens.lantern).not.toBe("#df8e1d");
    for (const token of ["lantern", "working", "blocked", "done", "team"] as const) {
      for (const under of ["ink", "peat", "active"] as const) {
        expect(ratio(hex(tokens[token]), hex(tokens[under])), `${token} on ${under}`).toBeGreaterThanOrEqual(3);
      }
    }
    // The palette itself, which terminal cells draw from, is untouched.
    expect(latte.palette[3]).toBe(0xdf8e1d);
  });

  it("gives GitHub Light Default a light scheme with its own text", () => {
    const { tokens, scheme } = chromeTokens(builtinTheme("GitHub Light Default")!.terminal);
    expect(scheme).toBe("light");
    expect(tokens.ink).toBe("#ffffff");
    expect(tokens.text).toBe("#1f2328");
  });
});

describe("ink", () => {
  it("leaves passing colors alone and moves failing ones the least that passes", () => {
    expect(ink(0xf9e2af, [0x1c1c22], 3)).toBe(0xf9e2af);
    for (const [color, background, target] of [
      [0xf9e2af, 0xebedf1, 3],
      [0x94e2d5, 0xffffff, 4.5],
      [0x303030, 0x101419, 4.5],
    ]) {
      const inked = ink(color, [background], target);
      expect(inked).not.toBe(color);
      expect(ratio(inked, background)).toBeGreaterThanOrEqual(target);
      expect(ratio(inked, background)).toBeLessThan(target + 0.5);
    }
  });
});

describe("parseThemeName", () => {
  it("reads one theme as both sides", () => {
    expect(parseThemeName(" Nord ")).toEqual({ light: "Nord", dark: "Nord" });
  });

  it("reads a light and dark pair in either order", () => {
    const pair = { light: "GitHub Light Default", dark: "Herdr Night" };
    expect(parseThemeName("light:GitHub Light Default,dark:Herdr Night")).toEqual(pair);
    expect(parseThemeName("dark: Herdr Night , light: GitHub Light Default")).toEqual(pair);
  });

  it("refuses a malformed pair", () => {
    for (const value of ["light:Nord", "light:Nord,light:Dracula", "light:,dark:Nord", "light:A,dark:B,dark:C", "light:A,Nord"]) {
      expect(parseThemeName(value), value).toBeNull();
    }
  });
});
