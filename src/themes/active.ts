// The theme the window shows. Its chrome goes onto :root as CSS tokens; the
// painter and `hueColor` read its terminal colors. Nothing reconnects or resizes.

import { HERDR_NIGHT, type NamedTheme } from "./catalog";
import { TOKENS } from "./chrome";

let current: NamedTheme = HERDR_NIGHT;

export function activeTheme(): NamedTheme {
  return current;
}

/// Sets every chrome token on :root, which overrides styles.css's Herdr Night.
export function applyTheme(theme: NamedTheme): void {
  current = theme;
  const style = document.documentElement.style;
  for (const token of TOKENS) style.setProperty(`--${token}`, theme.chrome.tokens[token]);
  style.colorScheme = theme.chrome.scheme;
}
