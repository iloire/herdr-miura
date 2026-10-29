# Plan: Settings, starting with themes

A settings file you can edit and provision, a Settings dialog (⌘,) that writes the same file, and themes
as the first thing it controls. The README's roadmap already lists "the config file and themes".

## Where we start from

- **Terminal colors** are already data: `terminal/theme.ts` has a `Theme` (foreground, background, cursor,
  256-color palette) and the painter draws from whatever `Theme` it is given. Only `DEFAULT_THEME` exists.
- **Chrome colors** are mostly CSS tokens on `:root` in `styles.css` (`--ink`, `--peat`, `--rule`, `--text`,
  `--muted`, `--lantern`, `--working`, `--blocked`, `--done`), but about 20 colors are still literal hex
  or `rgba()` (`#1b222a`, `#1f2730`, `#33404d`, `#fff`, the diff washes, the dialog scrim).
- **`app/hue.ts`** colors workspaces from `DEFAULT_THEME.palette`, so it must follow the active theme too.
- **Window state** (sidebar width, workspace sort, pins, last host) lives in `localStorage`. That stays:
  it is what the window remembers, not what you chose.
- **Font size** (⌘+ / ⌘- / ⌘0) lives only in controller state and resets on every launch.
- **herdr-gpui** already themes from Ghostty-format files: 28 bundled in `assets/themes/` (Nord, Gruvbox
  Material Dark, TokyoNight, Catppuccin, Rose Pine, GitHub Light, …), plus any theme in Ghostty's theme
  folders or at a path, and `light:X,dark:Y` to follow the system appearance. It derives its chrome
  (surface, active row, muted text, accent wash) from the theme in `config/theme.rs`. We port that rather
  than invent a format, so a theme name means the same thing in both apps.

## Decisions

- **One file, ours**: `~/.config/herdr/config-tauri.toml`, beside Herdr's `config.toml` and herdr-gpui's
  `config-gpui*.toml`. TOML because every other Herdr config is TOML. Our own file, so we never write into
  herdr-gpui's or trip its unknown-key warning.
- **Rust owns the file**, TypeScript owns the meaning. Rust reads it (`settings_load`), writes single keys
  with `toml_edit` so comments and hand edits survive (`settings_set(key, value)`), and tells the webview
  when it changes on disk. TS parses what it gets into a typed `Settings`, every key optional with a
  default, and reports unknown keys or bad values as a dismissible warning instead of failing the load.
- **Reload on change**: re-read when the window regains focus (the pattern `files/listing.ts` already
  uses). A `notify` file watcher only if that proves too slow.
- **Provisioned**: the file lives in `~/dotfiles/herdr/config-tauri.toml`, and ansible-recipes'
  `herdr_config` role symlinks it into place, so the dialog's writes land in dotfiles as a reviewable diff.
- **No settings in `localStorage`.** Moving window state into the file is not part of this.

## Themes

- **Format**: Ghostty theme files (`palette = N=#rrggbb`, `background`, `foreground`, `cursor-color`,
  `selection-background`, `selection-foreground`). Parsed in TS, tested with Vitest.
- **Where themes come from**, in order: the 28 files from herdr-gpui's `assets/themes/`, bundled with
  `import.meta.glob(..., { query: "?raw" })` and credited in a NOTICE; Ghostty's own theme folders
  (`/Applications/Ghostty.app/.../themes`, `~/.config/ghostty/themes`) listed and read by a Rust command;
  an absolute or `~/` path. Our current colors stay as the theme named `Herdr Night` and remain the default.
- **Chrome from the theme**: one function, `chromeTokens(theme)`, ported from herdr-gpui's `Theme`
  helpers, gives every CSS token: `--ink` the background, `--peat` the surface, `--rule`, `--text`,
  `--muted` (a mix toward the background), `--lantern` the cursor or yellow, `--working` blue,
  `--blocked` red, `--done` green, plus `color-scheme` light or dark by the background's luminance. A
  status color is nudged only when it falls below 3:1 on the surface, as herdr-gpui's `ink` does, so
  pastels still read on light themes. Terminal cells are never adjusted.
- **Applying it**: set the tokens on `document.documentElement.style`, hand the `Theme` to the painter and
  repaint every pane, and let `hueColor` read the active palette. Nothing reconnects or resizes.
- **Light and dark**: `theme = "light:GitHub Light Default,dark:Herdr Night"` follows
  `prefers-color-scheme`, switching live when macOS does.

## The settings to start with

The first release, each one small and each one something you would actually change:

| Key | Default | What it does |
| --- | --- | --- |
| `theme` | `"Herdr Night"` | A theme name, path, or `light:…,dark:…` pair. |
| `terminal.font_family` | `"JetBrains Mono"` (then the current fallback list) | The terminal's face. |
| `terminal.font_size` | `13` | Persisted: ⌘+ / ⌘- / ⌘0 write it, so the size survives a relaunch. |
| `terminal.line_height` | `1.4` | Row height as a multiple of the size, 1 to 2. |
| `ui.font_size` | `13` | The chrome's text size (sidebar, tabs, panels). |
| `confirm_close_tab` | `false` | Ask before closing a tab whose process is still running. |
| `new_tab.command` | none | What a new tab runs, e.g. `"claude"` (herdr-gpui's `plus_command`). |

Wanted soon after, once the feature behind them exists or is asked for:

- **`status_bar.claude_usage`, `status_bar.ports`**: hide a status bar item.
- **`dock_badge`**: which statuses count on the Dock badge (blocked, done), or off.
- **`notifications`**: with system notifications, on finish and on needing you, and a quiet delay.
- **`keys`**: override catalog shortcuts by command name, `""` to unbind, as herdr-gpui's `[pane_keys]`.
- **`terminal.cursor_blink`, `terminal.padding`**: small, but only if the default bothers someone.
- **`copy_on_select`**: once text selection lands.

Not settings: poll intervals, sidebar width, workspace sort and pins (window state, already remembered).

## The Settings dialog

- ⌘, opens it (a window command in `catalog.ts`, handled in `Controller.run`), drawn like
  `WorktreesDialog`.
- Sections: Appearance (theme picker with a live preview of the terminal colors and a sidebar card,
  fonts), Behavior (close confirmation, new tab command). Changes apply as you make them and are
  written straight to the file; there is no Save button.
- A theme search field, since the Ghostty folder alone holds hundreds.
- "Open settings file" opens it in the editor; a warning strip lists keys the file got wrong.

## Steps

1. ~~Tokenize `styles.css`: replace every literal color with a token or a `color-mix` of tokens, no visual
   change. Screenshot before and after to prove it.~~ ✅
2. ~~TS theme model: Ghostty parser, bundled themes, `chromeTokens`, contrast nudge. Vitest for the parser
   (a malformed line, a missing palette slot), the derivation on one dark and one light theme, and the
   `light:,dark:` pair. Break the nudge once and watch its test fail.~~ ✅
3. ~~Apply a theme live: tokens on `:root`, painter theme and repaint, `hueColor` from the active palette.
   Hardcode a second theme to check it end to end.~~ ✅
4. ~~Rust `settings.rs`: path, `settings_load`, `settings_set` with `toml_edit`, `theme_list` /
   `theme_read` for Ghostty's folders (paths resolved, nothing outside them or the named file read).
   Tests with `tempfile`, including that a comment survives a write.~~ ✅
5. ~~TS `app/settings.ts`: parse into `Settings` with defaults and warnings, reload on window focus, wire
   each starting setting through. Tests for defaults, bad values and unknown keys.~~ ✅
6. Settings dialog and ⌘,.
7. Provision: `~/dotfiles/herdr/config-tauri.toml` with the starting keys commented, the symlink in
   ansible-recipes `herdr_config`, applied here and checked through the dialog.
8. Docs: the file's keys in a `docs/settings.md` (the schema, next to nothing else), README status, the
   architecture table, CHANGELOG, and a screenshot with a light theme.

## Open questions

- **Share the theme with herdr-gpui?** A `theme = "Follow Herdr GUI"` value could read
  `config-gpui.local.toml`'s `theme`, so switching it there switches both apps. Cheap to add later; left
  out until you run both side by side.
- **Per-host terminal theme**, as herdr-gpui's device themes do, so an SSH-attached window looks
  different from this Mac's. Fits naturally once the host picker and themes both exist.
