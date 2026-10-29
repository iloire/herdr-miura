# Changelog

Newest first. Times are UTC.

## 2026-10-29 23:50 — Markdown files open as a page

A Markdown file opened from the Files panel was shown as its source with line numbers, hard to read
for anything longer than a page. It now opens rendered: headings, lists, tables, code blocks and the
checkout's own images, at a reading width, with Preview / Source in the header to see the text. A link
to another file of the checkout opens it in the same view, one to a heading scrolls there, and a web
link opens in the browser. The file's raw HTML is shown as text, never run, and web images (a README's
badges) show their alt text, since the window loads no images from the web.

## 2026-10-30 00:45 — A commit's diff stays in its column

Opening a commit with a long subject drew its diff wider than the window, over the Changes panel:
the subject never wraps, and the diff view's grid column grew to fit it. The column is now held to
the view's width, so the subject ends in an ellipsis and the diff scrolls inside its own column.

## 2026-10-29 19:30 — A frontend role in the starter team

New Team wrote a lead, a reviewer and a qa, so a repo with a UI had nobody whose job was how it looks.
The starter team now has a frontend role between the lead and the reviewer: it owns layout, type, colour,
motion and accessibility, extends the UI the repo already has, and screenshots its work at phone and
desktop widths before handing it to the reviewer and qa. Create from template writes it too.

## 2026-10-29 18:03 — Rename a workspace from its card

A workspace kept the name it was opened with, even after its panes moved to another folder, and nothing in
the app could change it. Right-click a workspace card and pick Rename…, or double-click the card: the name
becomes a field holding the current one. Enter renames it in Herdr, Escape or clicking away cancels. Tabs
use the same field.

## 2026-10-29 17:24 — Typing follows a move to another tab

Only a click on a tab handed the keyboard to its terminal. Moving with ⌥← / ⌥→, ⌘⇧[ / ⌘⇧], ⌘1–9, ⌥↑ / ⌥↓,
the palette, a workspace card, a team member or a queue item's tab left focus where it was, often on the
button just clicked, so typing went nowhere. `Controller.request` now gives the terminal focus after any
`tab.focus`, `workspace.focus` or `pane.focus`, whatever asked for it.

## 2026-10-29 17:10 — The panel switch moves to the title bar

The Changes, Files and Queue switch and the library's book sat at the tab bar's top right and took that
width from every row of tabs. The window now draws its own title bar over macOS's (`titleBarStyle:
Overlay`, the title hidden): a strip as tall as the old one that drags the window, shows its title centred
and holds the switch at its right end, so the tabs get the full width. The book moves into the tab header,
at its right end, since the library sends its prompts to that tab's agent rather than opening a panel; a
tab without agents now has a header holding only the book.

## 2026-10-29 15:32 — One switch for the side panel

The Changes, Files and Queue buttons sat after the tab rows, centred against them, so with tabs on several
rows they ended up beside some tab in the middle, and they did not match: Changes was a "±" glyph, the
Queue button was wider than the rest with its count beside the hourglass. They are now one switch held to
the tab bar's top right, level with the drawer's header however many rows the tabs take: a recessed track
of three keys of one size, Changes drawn as a page with a line added and one taken away, and the open
panel's key raised in the workspace's color. The waiting count is a badge on the hourglass's corner, which
still turns blue while a prompt runs. The prompt library's book stands just apart from it, since it opens a
palette rather than a panel.

## 2026-10-29 15:12 — A button for the prompt library

The prompt library opened only with ⌘⇧L or the command palette, so nothing on screen said it was there. A
book button at the right end of the tab strip, after the Queue hourglass, now opens it, and shows pressed
while it is open. It sits with the drawer's buttons because it acts on the focused workspace, as they do.

## 2026-10-29 15:10 — A calmer workspace card

A busy workspace's card put the team, queue, pins, loop, agent count and every status mark in one row beside
the name, and squeezed the name down to nothing. The card now reads in lines: the name with a tally of its
agents by status, the folder, the Git line, and a tray of chips under it for the team, queue, pinned tabs, loop
and ports, each in its own color, wrapping instead of crowding. A quiet workspace shows no tray at all. Ports
moved into the tray instead of hanging under the card.

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

## 2026-10-29 13:25 — Settings… in the macOS app menu

The Settings dialog could only be opened with ⌘, or from the command palette. The Herdr menu now has
**Settings…** (⌘,) under About. The rest of Tauri's default menu stays as it was (About, Hide, Quit, and the
Edit menu that copy and paste go through). A click emits `menu://open_settings`, and the webview runs the
catalog's `open_settings` for it. On macOS the menu item owns ⌘,, so the webview's own binding steps aside
and the dialog opens once. Linux and Windows keep Ctrl+,.

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
