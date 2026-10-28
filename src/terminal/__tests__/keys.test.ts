import { describe, expect, it } from "vitest";
import { keyInput, matches, parseShortcut, type KeyLike } from "../keys";

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: "",
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  repeat: false,
  ...over,
});

const code = (event: ReturnType<typeof keyInput>) => (event && "Key" in event ? event.Key : null);

describe("keyInput", () => {
  it("sends named keys", () => {
    expect(code(keyInput(key({ key: "Enter" })))?.code).toBe("Enter");
    expect(code(keyInput(key({ key: "ArrowLeft" })))?.code).toBe("Left");
    expect(code(keyInput(key({ key: "Escape" })))?.code).toBe("Esc");
    expect(code(keyInput(key({ key: "F5" })))?.code).toEqual({ F: 5 });
  });

  it("turns shift-tab into BackTab", () => {
    const event = code(keyInput(key({ key: "Tab", shiftKey: true })));
    expect(event?.code).toBe("BackTab");
    expect(event?.modifiers).toBe(1);
  });

  it("leaves plain printable text to the text input", () => {
    expect(keyInput(key({ key: "a", code: "KeyA" }))).toBeNull();
    expect(keyInput(key({ key: "A", code: "KeyA", shiftKey: true }))).toBeNull();
  });

  it("sends control chords with the physical key", () => {
    const event = code(keyInput(key({ key: "c", code: "KeyC", ctrlKey: true })));
    expect(event).toMatchObject({ code: { Char: "c" }, modifiers: 2, kind: "Press" });
  });

  it("sends Option chords as Alt rather than the layout's character", () => {
    const event = code(keyInput(key({ key: "π", code: "KeyP", altKey: true })));
    expect(event).toMatchObject({ code: { Char: "p" }, modifiers: 4 });
    expect(keyInput(key({ key: "π", code: "KeyP", altKey: true }), false)).toBeNull();
  });

  it("leaves Cmd chords to the app", () => {
    expect(keyInput(key({ key: "Enter", metaKey: true }))).toBeNull();
  });

  it("marks held keys as repeats", () => {
    expect(code(keyInput(key({ key: "Backspace", repeat: true })))?.kind).toBe("Repeat");
  });
});

describe("shortcuts", () => {
  it("parses GPUI keystrokes", () => {
    expect(parseShortcut("cmd-shift-d")).toEqual({ cmd: true, ctrl: false, alt: false, shift: true, key: "d" });
    expect(parseShortcut("cmd-alt-left")).toMatchObject({ cmd: true, alt: true, key: "left" });
    expect(parseShortcut("cmd--")).toEqual({ cmd: true, ctrl: false, alt: false, shift: false, key: "-" });
    expect(parseShortcut("hyper-x")).toBeNull();
  });

  it("matches the physical key whatever it types", () => {
    const shortcut = parseShortcut("cmd-shift-]");
    expect(shortcut).not.toBeNull();
    if (!shortcut) return;
    expect(matches(shortcut, key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }))).toBe(true);
    expect(matches(shortcut, key({ key: "]", code: "BracketRight", metaKey: true }))).toBe(false);
  });

  it("requires the exact modifiers", () => {
    const shortcut = parseShortcut("cmd-d");
    if (!shortcut) throw new Error("unparsed");
    expect(matches(shortcut, key({ key: "d", code: "KeyD", metaKey: true }))).toBe(true);
    expect(matches(shortcut, key({ key: "d", code: "KeyD", metaKey: true, altKey: true }))).toBe(false);
  });
});
