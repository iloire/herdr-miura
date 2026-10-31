import { ALT, CONTROL, SHIFT, type KeyCode, type PaneInputEvent } from "../protocol";

/// The parts of a `KeyboardEvent` key mapping reads, so tests need no DOM.
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

const NAMED: Record<string, KeyCode> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "Backspace",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Esc",
  Home: "Home",
  Insert: "Insert",
  PageDown: "PageDown",
  PageUp: "PageUp",
};

/// The base character of a chord's physical key, so Option-P on macOS sends
/// `p` with Alt rather than the `π` the layout would type.
function chordChar(event: KeyLike): string | null {
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) return digit[1];
  if (event.code === "Space") return " ";
  return [...event.key].length === 1 ? event.key.toLowerCase() : null;
}

function modifierBits(event: KeyLike): number {
  return (event.shiftKey ? SHIFT : 0) | (event.ctrlKey ? CONTROL : 0) | (event.altKey ? ALT : 0);
}

/// A key press for the pane, or null when it belongs elsewhere: Cmd chords
/// are the app's, and plain printable text arrives through the text input so
/// layouts, dead keys, and IME composition keep working.
export function keyInput(event: KeyLike, optionIsMeta = true): PaneInputEvent | null {
  if (event.metaKey) return null;
  let code: KeyCode | undefined = NAMED[event.key];
  if (event.key === "Tab") code = event.shiftKey ? "BackTab" : "Tab";
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key);
  if (fn) code = { F: Number(fn[1]) };
  if (!code && (event.ctrlKey || (event.altKey && optionIsMeta))) {
    const char = chordChar(event);
    if (char) code = { Char: char };
  }
  if (!code) return null;
  return {
    Key: {
      code,
      modifiers: modifierBits(event),
      kind: event.repeat ? "Repeat" : "Press",
      repeat_count: 1,
      shifted_codepoint: null,
      generated_text: null,
      tracks_release: false,
      physical_key_id: null,
      windows_record: null,
    },
  };
}

export interface Shortcut {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/// Parses GPUI keystroke syntax (`cmd-shift-d`, `cmd-alt-left`, `cmd--`).
export function parseShortcut(text: string): Shortcut | null {
  const parts = text.split("-");
  // A trailing `-` key splits into two empty parts.
  const key = parts.length > 1 && parts.at(-1) === "" ? "-" : parts.pop();
  if (!key) return null;
  if (key === "-") parts.splice(-2);
  const shortcut: Shortcut = { cmd: false, ctrl: false, alt: false, shift: false, key };
  for (const part of parts) {
    if (part === "cmd" || part === "super" || part === "win") shortcut.cmd = true;
    else if (part === "ctrl") shortcut.ctrl = true;
    else if (part === "alt") shortcut.alt = true;
    else if (part === "shift") shortcut.shift = true;
    else return null;
  }
  return shortcut;
}

const GPUI_KEYS: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backspace: "backspace",
  Enter: "enter",
  Escape: "escape",
  Tab: "tab",
  " ": "space",
};

/// The GPUI key name of an event's physical key, unshifted.
function gpuiKey(event: KeyLike): string {
  if (GPUI_KEYS[event.key]) return GPUI_KEYS[event.key];
  const map: Record<string, string> = {
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Backslash: "\\",
    Quote: "'",
    Backquote: "`",
  };
  if (map[event.code]) return map[event.code];
  return chordChar(event) ?? event.key.toLowerCase();
}

export function matches(shortcut: Shortcut, event: KeyLike): boolean {
  return (
    shortcut.cmd === event.metaKey &&
    shortcut.ctrl === event.ctrlKey &&
    shortcut.alt === event.altKey &&
    shortcut.shift === event.shiftKey &&
    shortcut.key === gpuiKey(event)
  );
}

/// Whether a chord pressed in a text field goes on to the app's shortcuts. Cmd
/// and Ctrl chords do. Option alone stays with the field (⌥←/→, ⌥⌫, and ⌥-letter's
/// special characters), but for ⌥↑/↓: moving between workspaces matters more than
/// macOS's jump to the paragraph's end. `keepsArrows` holds those back too, for a
/// field that moving away would hide or lose.
export function fieldPassesChord(event: KeyLike, keepsArrows: boolean): boolean {
  if (event.metaKey || event.ctrlKey) return true;
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
  return vertical && event.altKey && !event.shiftKey && !keepsArrows;
}

/// A shortcut as the menus show it on macOS: `⌘⇧D`.
export function shortcutLabel(shortcut: Shortcut): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return (
    (shortcut.ctrl ? "⌃" : "") +
    (shortcut.alt ? "⌥" : "") +
    (shortcut.shift ? "⇧" : "") +
    (shortcut.cmd ? "⌘" : "") +
    ({ left: "←", right: "→", up: "↑", down: "↓", enter: "↩", backspace: "⌫" }[key] ?? key)
  );
}
