# Changelog

Newest first. Times are UTC.

## 2026-10-29 15:05 — A prompt library

Prompts you send often had nowhere to live but a note, and reached an agent by copy and paste. They are now
Claude Code's own command files, `~/.claude/commands/*.md` and a repo's `.claude/commands/*.md`, so one
file is `/name` inside Claude and an entry in Herdr's ⌘⇧L palette. Project prompts list first and hide a
global one of the same name; a file that cannot be used (frontmatter that does not parse, too large, a link
out of the repo) is listed as broken with the reason rather than skipped. The selected prompt's text can be
edited before it goes to the focused agent (⌘1), a fresh Claude in a new tab (⌘2) or the workspace's queue
(⌘3). An optional `herdr.run` key picks what Enter does. Pins, variables and the rest are later steps in
[docs/plan-prompt-library.md](docs/plan-prompt-library.md).

## 2026-10-29 14:25 — Copy a finished prompt

A prompt that stopped or failed (its tab closed, its agent exited, you removed it) showed only its first line
in the done list, so there was no easy way to get its text back to queue it again. Each finished row now has
a copy button beside its open-tab button that puts the whole prompt, every line, on the clipboard and shows a
check for a moment. It goes through Tauri's clipboard plugin (already in the Rust side; its JS package and
`clipboard-manager:allow-write-text` are new) rather than `navigator.clipboard`, which the built app's custom
scheme may not allow.

## 2026-10-29 14:10 — A workspace's queue stays on one folder

Queues are kept by folder, and a workspace that herdr names no folder for took the focused tab's, so focusing
a tab in another checkout (an agent started in `~/dotfiles`, say), or a restart that focused one, showed that
folder's empty queue in place of the real one. Nothing was lost, but it looked lost. Such a workspace's folder
is now the one most of its tabs are in, whichever tab is focused, and the panel's header shows it. A window
that does not own the queue (another window holds `queue.lock`) says so instead of showing an empty queue
whose Add button silently did nothing, and a dev build started with its own app id labels its queue a test
queue.

## 2026-10-29 13:54 — A gear for Settings in the status bar

The Settings dialog opened only with ⌘, or from the command palette. A gear button at the right end of the
status bar, after the commands hint, now opens it too (through the same `open_settings` command). It sits
with the app-wide things in the status bar rather than with the tab strip's panel buttons, since settings
belong to the whole app.

## 2026-10-29 13:20 — One window owns the queue, with backups

Two windows of the app (the daily one and a worktree's dev build) share one data folder and each saved the
queue whole from memory, so one overwrote prompts the other had taken from the inbox: two queued prompts
were lost. Now the first window to load the queue holds an exclusive lock on `queue.lock` until it exits,
and any other leaves the queue and its inbox alone, retrying every 5 s. A save first copies the file it
replaces into `queue-backups/` (hourly, last 48 kept), and inbox files move to `queue-inbox/taken/`
(kept 30 days) instead of being deleted.

## 2026-10-29 12:55 — No dev bar on main

A `tauri dev` window on `main` no longer shows the `DEV · main` strip or `[main]` in its title; feature
branches and worktrees still do.

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
