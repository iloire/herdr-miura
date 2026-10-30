# Changelog

Newest first. Times are UTC.

## 2026-10-30 17:34 — Tabs can stay on one row

A new setting, `tabs.wrap`, and a checkbox under Behavior in Settings, choose what tabs do when they do not fit.
On, the default, they wrap onto more rows as before. Off, they stay on one row of at least 140 px each that
scrolls sideways with no scrollbar, by trackpad or mouse wheel. The + stays at the row's end, and the open tab is
scrolled into view whenever it changes.

## 2026-10-30 17:30 — Stable, Edge and dev each have their own icon

All three showed the same icon, so the Dock could not tell them apart. Stable keeps the yellow and cyan, Edge is
violet, and a `tauri dev` window or a build made by hand is red. `tauri.conf.json` names the red icon, because Tauri
reads a dev run's Dock icon from there and offers no other way to set it, and `herdr-channels` passes Stable and
Edge their own with `--config`.

## 2026-10-30 17:18 — An expanded card lists three ports, then `+N more`

An expanded workspace card listed every listening port, so a workspace running Docker could push the rest of the
sidebar down by eight rows or more. The Ports section now shows the first three and a `+N more` toggle under them
that opens the rest and turns into `Show less`. Three ports or fewer show as before, with no toggle. Whether the
list is open is `PortList`'s own state, so it closes with the card and is not saved.

## 2026-10-30 17:18 — The picked workspace card's background is gray in every hue

The card's rail keeps the workspace's color, but the wash behind it no longer takes that color, so a purple or
red workspace reads as clearly as a teal one. The hover on any card goes gray too, and so does the card in the
Settings preview. A card with an agent waiting on you keeps its amber.

## 2026-10-30 15:13 — Open a finished prompt to read it

Clicking a prompt in the Queue panel's finished list now opens a dialog with its whole text, when it was added,
started and finished, how long it waited and ran, what queued it, the folder and branch it ran in, and the commits
it left, each with its short hash and subject. A stopped prompt says why at the top. The dialog can copy the prompt
and go to its tab while that is open. Commits are read from Git when it opens, so one whose worktree was removed
says it cannot read them. The row's copy and open-tab buttons stay, and its time now reads `1h 5m` past the hour,
and `<1m` under a minute.

## 2026-10-30 15:07 — A collapsed card lists only the agents that need you

A collapsed workspace card had a row for every agent that finished, so three of them and a `+2 more` turned a
one-line card back into a tall one. It now has rows only for blocked agents, with the same limit of three and
`+N more`. Finished agents are still counted in the card's tally, and each one has a row in the Agents section
when the card is expanded.

||||||| parent of 3e758ab (feat: a finished prompt opens to show how it ran - a finished row only had a clipped title, a tooltip and two numbers, so clicking it now opens a dialog with the whole prompt, a timeline of when it was added, started and ended with the wait and the run between them, what queued it, where it ran and the commits it left. The commits are not stored: queue_log takes the count oldest after the item's head, so what landed later stays out and items already in history work too. A stopped prompt says why, and a removed worktree says its commits cannot be read. Times now share formatSpan, so a row reads 1h 5m past the hour. Checked with the real queue_log over IPC in a dev window on a separate Herdr session, and the real panel in a browser with a stubbed backend, since an uncovered WKWebView window does not paint)
## 2026-10-30 14:53 — Workspace cards stay on their own folder

A workspace card took its Git data from whichever folder its active tab was in. A notes workspace with a tab
in another repo listed that repo's worktrees, and a workspace on one of them nested under notes as if notes
were its main checkout. A card's changed-file count, worktree list and nesting, team file, tooltip and folder
menu now read the folder the workspace was fixed on, whichever tab is active. A workspace the window has not
seen yet, and any on a remote host, still use the active tab's folder. The tab strip's Git state and the
stray-path warning still follow the focused pane.

## 2026-10-30 14:47 — Run a queued prompt now, in a worktree of its own

Right-clicking a waiting prompt in the Queue panel now offers Run in a Worktree Now, for the quick job stuck
behind a long one or a dirty checkout. It makes `.claude/worktrees/<title>-<id>` on `feat/<title>-<id>` from the
checkout's current commit, in a workspace of its own, and starts the prompt there straight away, even while the
queue is paused. If the worktree cannot be made, the prompt goes back to the front of those waiting.

The prompt stays in the main checkout's queue, shown as a running card with its branch, so removing the worktree
strands nothing. Its agent does not hold the queue back, and whatever ends it, the worktree being removed included,
never pauses the queue: it goes to the finished list with its prompt, and the next prompt carries on. It does not
use up Pause after. Claude asks to trust each new folder, so the card waits there until that is answered in its tab.
The agent is told to commit on the branch and stop; landing it stays with you, and the `⑂` mark shows it pending.

Queued prompts now open in the main checkout's workspace when one is open. `herdr worktree remove` closes the
worktree's whole workspace, so a prompt that had started in a worktree's workspace, as could happen when that
workspace came first, was closed with it. With only a worktree's workspace open, it is still used. The worktrees
folder is added to the repo's `.git/info/exclude` when missing, or it would read as a change in the checkout and
pause any queue set to wait for a clean tree.

## 2026-10-30 14:34 — A queue lives on the main checkout, never on a worktree

A workspace's queue followed its active tab, so with the tab in `.claude/worktrees/agent-age` two prompts
were filed under that worktree, and removing it stranded them: the first failed and the queue paused. Queues
are now kept on the workspace's fixed root mapped to its main checkout, from any worktree wherever it lives.
Git answers once while the worktree exists and the answer is saved, so it survives the removal; a root that
was already gone uses the folder most of the tabs are in. `herdr-queue` does the same for `--folder` and for
the checkout it falls back to. A worktree's workspace now shares its main checkout's queue, so a prompt meant
for a branch has to name it. A folder that really is gone now says so instead of "not a pane, tab, or
workspace id", in the queue and in the team dialog. The item still fails and the queue still pauses then.

## 2026-10-30 14:13 — The tab strip shows how long an agent has been working or blocked

Each agent in the strip over the terminal now shows `working 40m` or `blocked 12m` right after its name, the
blocked one in the blocked colour, to help decide which tab needs you first. Only working and blocked show, and
only from one minute up.

The snapshot carries no time for an agent, so the app keeps one for every agent, background tabs included. The
time counts from when the app first saw the status, so it restarts with the app, and the tooltip says so.

## 2026-10-30 13:24 — The right panels lose their × and the switch hands focus back

Changes, Files and Queue no longer have a × in their header: it sat next to the panel switch, whose lit toggle already
closes the panel. Closing a panel with its toggle, ⌘⇧E, ⌘⇧A or the command palette now puts the cursor back in the
terminal, as the × did, so you can type straight away. Opening a panel moves nothing, and the queue still puts the
cursor in its prompt box. A diff left open comes back when Changes reopens, and a diff or file view keeps its own × and
Esc.

## 2026-10-30 13:14 — Workspace cards collapse to one line and expand to show more

A workspace card is now a single line: the name, its Git counts, the queue, any loop and the agent tally. Agents that
finished or wait on you still get a row under it, three at most and then `+N more`, and a click goes to their tab. The
chevron opens the card to show the branch, chips and three lists: worktrees with what is pending in each, every agent,
and every port with its process. Each row goes where it names, and a card stays open until you close it. A card with
nothing more to show has no chevron.

The Agents section at the bottom of the sidebar and its `ui.sidebar_agents` setting are gone, because the cards now
hold those agents next to their workspace. A settings file that still sets the key gets the usual warning that it does
nothing.

## 2026-10-30 13:08 — A queued tab's tooltip shows its whole title

A queued prompt's tab label was cut to 40 characters when the tab opened, so its tooltip ended in `…` too. The label
now keeps the prompt's first line, up to 200 characters, and the pill still cuts it to its width. Tabs that are
already open keep the label they were given.

## 2026-10-30 13:05 — The tab strip shows this tab's listening ports

The strip over the terminal now shows the ports of the servers started in this tab, after the Git state, each number
opening its page, so a dev server in a feature worktree is one click away. A tab with no servers shows nothing, and
the status bar's ports and the card's globe stay as they were, per workspace.

The scan reads each listener's `HERDR_PANE_ID` and the strip matches it against the snapshot's panes, so a server
follows its pane to another tab of the workspace. Moved to another workspace, a pane takes a new id, so its servers
leave the strip and keep counting under the old workspace; Herdr never gives the old id out again, so they cannot show
in the wrong tab. A listener from an older Herdr, with no pane id, stays out of the strip. The ports do not shrink on a
tight strip, and a tab with very many stops at half of it, the rest in the status bar.

## 2026-10-30 12:50 — The tab strip shows the agent's title

Each agent's group over the terminal now ends in the agent's title, in full when there is room, with the whole
text in its tooltip. It is the first thing to give way on a tight strip: the titles shrink to nothing before the
branch name, the queue line or any fact moves. Nothing else changed size, and a title squeezed out leaves no gap.

The title comes from `terminal_title_stripped`, not `Agent.title`, which Claude Code leaves empty. So it is the
terminal title without its `✳` or spinner, and for a queued tab it is not the prompt the tab's label cuts short.
An integration's reported title wins if there is one. A blank title or one that repeats the agent's name, such as
Claude Code's default `Claude Code`, shows nothing.

## 2026-10-30 12:47 — The tab strip shows a pane in an unexpected place

To catch an agent working in the wrong place, the strip now starts with a short amber path when the focused pane's
checkout is not its workspace's root: `.claude/worktrees/foo` for a worktree inside the root, `~/code/other-repo`
for anywhere else. The full path is in its tooltip and a long path truncates. Outside Git the pane's directory
stands in for the checkout. It stays quiet on the root, in a subdirectory of the same checkout, and for a workspace
opened on a repo's subfolder.

Herdr keeps no fixed folder for a workspace: `new_workspace_cwd` follows the focused pane, so the window now
fixes a root itself the first time it sees a workspace, the folder most of its tabs are in, and remembers it for
as long as the daemon runs. Workspaces open when this first runs, and all of them after a daemon restart, get
that estimate rather than the folder they were opened on.

## 2026-10-30 12:30 — The tab strip shows the tab's Git state

The strip over the terminal now starts with the Git state of the focused pane's checkout, because tabs of one
workspace can sit in different worktrees and the sidebar card cannot tell them apart. It shows the branch (not
main or master), ±changed files, ↑ahead, ↓behind and `N unmerged` with the base branch in its tooltip, each only
when it has something to say, so a clean, pushed main shows none of it. Unpushed work on main does show.

The checkout is now read every 15 s with the Changes and Files panels closed, on this Mac only; an open panel
keeps its 5 s. The strip ignores a read of any other directory, so on a tab switch it is empty until the new read
is in and never shows the last tab's branch. The panels go by the last read they saw, so these reads do not close
an open commit or use up the diff waiting to reopen.

The strip stays one line. When it runs out of room the branch name truncates down to 12 characters, then the
queue line, then each agent's rightmost facts are cut off. The Git counts and the prompt library always stay.

## 2026-10-30 12:17 — The drawer is resizable

The right-hand drawer that holds Changes, Files and Queue was stuck at 320 px. Its left edge now resizes it the
way the sidebar's does: drag it, double-click for 320 px, or focus it and use the arrow keys. It goes from 260 to
640 px, and the width is remembered between launches. All three panels share the one width.

The drawer takes at most half of what the sidebar leaves, so the terminal is never narrower than the drawer. In
a window too narrow for that, the drawer goes under 260 px rather than squeeze the terminal, and it returns to
the saved width when there is room again, as it does when the sidebar is narrowed or hidden. A click on either
edge that moves nothing no longer saves a width the window had only shrunk.

## 2026-10-30 12:07 — The ports globe is gray and sits on the name line

A workspace whose only extra was its ports gave a whole row to one green chip. The globe is now a plain gray
mark beside the agent tally, so it takes no row and no longer reads as a status.

## 2026-10-30 11:55 — An optional Agents section in the sidebar

A new setting, `ui.sidebar_agents` (off by default, and in Settings under Appearance), lists every running
agent at the bottom of the sidebar, above the Team section, grouped by workspace on the same rail colors as
the cards. A row shows the agent's tab and its status mark, and a click focuses that tab. While the section
shows, the workspaces, agents and team each scroll in their own space, so a long list cannot push the team
off screen. With the setting off the sidebar is as it was. Herdr's agent age is left out: the snapshot
carries no time for an agent, only sequence numbers.

## 2026-10-30 11:46 — The new tab button has its own icon

The tab bar's + sat beside the tabs' × and was easy to mistake for it, so it is now a small tab with a plus
inside.

## 2026-10-30 11:41 — New icons for Changes, Files and Queue

Changes is now a path from one commit to the next instead of a page with a plus and a minus, and Files is a
page with a folded corner instead of a folder; the same page marks a file in the Files tree. The Queue's
hourglass is now a list with a play mark, in the panel switch, on the card and in the status bar. A list can't
flip like the hourglass did, so while a prompt runs the icon pulses instead.

## 2026-10-30 11:37 — A workspace card shows a globe, not its ports

A workspace with more ports than fit ran off the card's right edge, because the chip holding them could
not wrap. The card now shows only the globe, with every port and its process in the tooltip. A click
focuses the workspace, and the status bar lists its ports, each one opening its page.

## 2026-10-30 11:31 — No title bar: the tab row is the top of the window

The 30 px title strip is gone, so the terminal gets that height back. The traffic lights and the app's name
now sit at the top of the sidebar, in a row that stays put while the list scrolls, and tabs take the row
beside them; the tab bar's empty space drags the window. The window's full title is the name's tooltip. The
Changes, Files and Queue switch is pinned to the window's top right corner, over the tab row and over the
open drawer, whose header is now as tall as the tab row: a diff covers the tabs, so the switch could not
live in the tab bar.

## 2026-10-30 11:26 — A quieter chrome and pill tabs

The sidebar and bars now sit barely off the terminal's background (2% toward the text, was 5%) with softer
rules (7%, was 10%), so a hover or a selection does the separating. Herdr Night's hand-drawn values moved to
match. The open tab is a raised pill edged in the workspace's hue instead of an underline, the tab bar loses
its hue tint, and a tab's status mark moves after its name.

## 2026-10-30 10:25 — No Start button in the Team section

The Team header's **Start all** / **Start N** button is gone, so the header is only its title, which
still opens the team dialog. To start a role, click its row: one that is not running starts, and one
that is running focuses its tab.

## 2026-10-30 10:04 — The workspace card no longer shows its folder

The name and the path under it said the same thing on nearly every card, so the path is gone and
each card is a line shorter. Hovering the name shows the full folder, and the right-click menu still
copies or opens it.

## 2026-10-30 09:57 — The running prompt's buttons stay on one line

In the queue panel, Open tab, Pause after and Remove squeezed into a row too narrow for them, so
their labels broke onto two lines. Remove is now the × the waiting prompts use, pushed to the right
edge with its full meaning on hover, and a label never wraps: a narrower panel moves a button to the
next row instead.

## 2026-10-30 09:56 — The card drops the branch name on main and master

The Git line said `main ±8` on the default branch, where the name tells you nothing. A card on `main` or
`master` now shows only `±8`, and a card with nothing pending there has no Git line at all. Any other
branch still shows, because it warns the checkout is off the default branch. ↑, ↓, ± and ⑂ are unchanged,
and ↑ or ↓ alone now keep the line, which the old test only did by leaning on the branch being there.
The names are matched literally. The Changes panel still shows the branch.

## 2026-10-30 09:51 — No team mark on the workspace card

The card showed a violet team icon and count beside its other chips. It added little: the Team section
under the workspace list already shows the focused workspace's roles and their state, so the mark is
gone. A team file with a mistake in it now shows only there too.

## 2026-10-30 09:35 — The + has a plain-terminal click and a shortcut

With `new_tab.command` set, the mouse could only open a tab running it, and the keyboard only a plain
one. ⌥-click on + now opens a plain terminal, and ⌘⇧T does what + does (the palette's New Tab with
Command). ⌘T stays a plain terminal.

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
