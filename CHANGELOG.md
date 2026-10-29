# Changelog

Newest first. Times are UTC.

## 2026-10-29 12:47 — Settings docs

- `docs/settings.md` documents every key of `config-tauri.toml` and how a theme is found. The README, its status
  and roadmap, and the architecture tables cover settings and themes; a screenshot shows GitHub Light Default.

## 2026-10-29 12:43 — Provisioned settings file

- `~/.config/herdr/config-tauri.toml` is a symlink into dotfiles (`herdr/config-tauri.toml`, every key commented
  out at its default), made by ansible-recipes' `herdr_config` role. A write from the Settings dialog lands in the
  dotfiles copy, below its comments, with the link intact.
- Fixed: the read on launch and a read after a write could answer out of order and leave the older settings on
  screen. Only the latest read is applied now.

## 2026-10-29 12:39 — Settings dialog

- ⌘, opens Settings: the theme (one, or a light and dark pair that follows macOS) with a search and a preview in
  the theme's own colors, the terminal font, size and line height, the interface text size, the close
  confirmation and the new tab command. Each change is written to the file at once; there is no Save.
- "Open settings file" opens it in VS Code.
- Fixed: changing a terminal font setting no longer moves the focus out of the dialog.

## 2026-10-29 12:34 — Settings from config-tauri.toml

- The window reads `~/.config/herdr/config-tauri.toml` on launch and whenever it comes back to the front. A bad
  value or an unknown key is a dismissible warning, never a failed load.
- ⌘+ / ⌘- / ⌘0 save the terminal size, so it survives a relaunch.
- New settings: `terminal.font_family`, `terminal.line_height`, `ui.font_size`, `confirm_close_tab` and
  `new_tab.command`.

## 2026-10-29 12:28 — Settings file and theme folders (Rust)

- `settings_load` / `settings_set` read the file and write one key at a time with `toml_edit`, keeping comments;
  `theme_list` / `theme_read` read Ghostty's theme folders, and a path only when the file names it.

## 2026-10-29 12:23 — Themes apply live

- A theme sets the chrome's colors, the terminal's colors and the workspace hues at once, without reconnecting.

## 2026-10-29 12:18 — Theme model

- Ghostty theme files, herdr-gpui's 28 bundled themes and five hand palettes under the same names, and chrome
  colors derived from a theme, with status colors nudged to 3:1 on the chrome. Terminal colors are never changed.
  The current colors are the theme Herdr Night, the default.

## 2026-10-29 12:12 — Chrome colors as tokens

- Every color in `styles.css` is a CSS token, so a theme can set all of them. Nothing looks different.
