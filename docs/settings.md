# Settings

Herdr Miura reads `~/.config/herdr/config-tauri.toml` (`$XDG_CONFIG_HOME/herdr/` when that is set), beside
Herdr's `config.toml` and herdr-gpui's `config-gpui*.toml`. It is this app's own file, so it never trips
herdr-gpui's unknown-key warning.

- **Every key is optional.** A missing key, or a missing file, is its default.
- **Nothing fails the load.** A bad value keeps its default, and a key that is not a setting does nothing.
  Both show as a dismissible warning over the terminal, and at the top of the Settings dialog. A file that
  does not parse is all defaults, with the parser's message.
- **The Settings dialog (⌘, or the gear at the right end of the status bar) writes the same file**, one key at a time, keeping comments and layout. A key it
  adds to a file of commented-out keys goes below them. Setting a value back to its default removes the key.
- **Edits by hand** are read when the window comes back to the front.

Window state (sidebar width, workspace sort, pins, the last host) is not a setting: the window remembers it in
`localStorage`.

## Keys

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `theme` | string | `"Herdr Night"` | The theme: a name, a path, or a light and dark pair (below). |
| `confirm_close_tab` | boolean | `true` | Ask before closing a tab or pane would stop an agent mid-task: one working, blocked or looping. Set `false` to close at once. Idle and finished agents close without asking, and so does a shell or a server, as Herdr reports agents, not other processes. |
| `terminal.font_family` | string | `"JetBrains Mono"` | The terminal's face, followed by `"SF Mono", Menlo, "DejaVu Sans Mono", monospace`. A value with a comma is used as a whole CSS font list. |
| `terminal.font_size` | number, 8 to 32 | `13` | The terminal's size in points. ⌘+ / ⌘- / ⌘0 write it, so the size survives a relaunch; ⌘0 removes the key. |
| `terminal.line_height` | number, 1 to 2 | `1.4` | Row height as a multiple of the size. |
| `ui.font_size` | number, 10 to 18 | `13` | The chrome's text size (sidebar, tabs, panels, dialogs). Every font size in the stylesheet scales by `size / 13`. |
| `ui.sidebar_agents` | boolean | `true` | Give the sidebar an Agents tab beside Workspaces: every agent that is waiting on you, working or finished unseen, grouped by that status, then the ones that went idle in the last 12 hours, folded workspace groups included. A row names its workspace and goes to the agent's tab. The tab shows how many need you; ⌘⇧G switches between the two. Off, the sidebar is only the workspaces. |
| `tabs.wrap` | boolean | `true` | Tabs that do not fit wrap onto more rows. `false` keeps one row, which scrolls sideways with no scrollbar and keeps the open tab and the + in view. |
| `new_tab.command` | string, one line, at most 1024 characters | none | What the tab strip's + and ⌘⇧T type into the new tab's shell, e.g. `"claude"`, as herdr-gpui's `plus_command`. ⌥-click on + or ⌘T always opens a plain shell, and + turns into an outlined terminal icon while ⌥ is held. |
| `workspace_colors` | table of folder to color | none | A workspace's color, chosen in its right-click menu: each key is a workspace's folder as a full path, then `#` and its name (quoted in TOML), and each value is `red`, `green`, `yellow`, `blue`, `magenta` or `cyan`. See below. |
| `workspace_groups` | table of folder to group name | none | The sidebar group a workspace is in, chosen with Move to Group on its right-click menu, keyed as `workspace_colors` is. See below. |
| `workspace_cards.git_status` | boolean | `true` | Show the Git counts on every card: ↑ to push, ↓ to pull, ± changed files. |
| `workspace_cards.agent_status` | boolean | `true` | Show the agent status marks and tally on the head of every card. |
| `workspace_cards.details` | `"manual"`, `"auto"`, `"always"` or `"never"` | `"manual"` | When a card's details show. See below. |
| `workspace_cards.compact` | boolean | `false` | Tighter card rows, so more workspaces fit. |
| `todoist.filter` | string | `"today \| overdue"` | Which tasks the Todoist panel lists, in Todoist's own filter syntax, e.g. `"#Herdr & @agent"`. The token is not a setting: see [plan-todoist.md](plan-todoist.md). |
| `todoist.projects` | table of Todoist project to folder | none | The repo each Todoist project's tasks are for, so the Todoist panel shows the focused workspace's. Each key is a project's name (any case, quoted in TOML when it has spaces), each value a folder as a full path or under `~`. See below. |

```toml
theme = "light:GitHub Light Default,dark:Herdr Night"
confirm_close_tab = false

[terminal]
font_family = "Iosevka"
font_size = 14
line_height = 1.3

[ui]
font_size = 14

[tabs]
wrap = false

[new_tab]
command = "claude"

[workspace_colors]
"/Users/me/code/notes#notes" = "cyan"

[workspace_cards]
git_status = false
agent_status = false
details = "never"
compact = true
```

## Workspace cards

The Workspace cards section of the Settings dialog chooses what the sidebar's cards show. It applies to every card:
per-workspace choices would make cards harder to compare, so there is nothing for it in a card's menu.

- `details`: `manual` is the chevron, and a card stays open until it is closed. `auto` follows the card's agents, as
  below. `always` keeps open every card that has something to show, and `never` keeps every card on one line. Neither
  of those shows a chevron, which would do nothing. None of the three forgets what the chevron chose in `manual`:
  going back restores it.
- With `details = "auto"` a card is open while one of its agents is blocked, needs you, is working or finished unseen.
  It closes once they are all seen or idle, so a finished agent keeps its card open until you look. This reads the
  agents as they stand, so a card with an unseen finished agent is open from launch, too.
  - A card opens at once and closes 2 seconds after its agents stop calling for it. An agent that stops and starts
    again within that doesn't make the card flicker.
  - The chevron overrides the rule for that card until the automatic state, open or closed, next changes. A card you
    closed stays closed while its agent goes from working to done, as both mean open, and an agent that blocks then
    shows its row on the collapsed card as it would in any mode. The next change back to closed ends the override, and
    so does leaving `auto`.
  - Nothing here goes into the list `manual` keeps. An override lasts as long as the window does.
- `git_status` takes away only the counts. An expanded card keeps its branch, and ⑂ stays, as the way to a checkout's
  worktrees.
- **No setting hides an agent that needs you.** A blocked or needs-you agent keeps its row on a collapsed card and an
  expanded card lists it, and the card keeps its gold, the Dock badge its count. With `details = "never"` there is nothing to
  expand, so the card lists all of them instead of three and `+N more`.
- With `agent_status` off a finished agent has no mark on a collapsed card, as the tally was its only one. It is still
  in the Dock badge, and has a row on an expanded card.

## Workspace colors

Every workspace has an automatic hue from its name. A workspace's right-click menu has a row of swatches to choose
one of the six palette colors instead, or Automatic to go back; the row writes `workspace_colors`, and Automatic
removes the entry. The file stores the color's name, not a value, so it follows the theme.

- A chosen color replaces the automatic hue everywhere the workspace's hue shows: the tab strip, the status bar, the
  Queue panel and the Worktrees and Team dialogs. On the card it colors the rail with a faint tint; automatic cards
  stay neutral. The current card's highlight and the gold of a card that needs you replace it while they show.
- The key is the folder the workspace's card reads and its name, so workspaces on one folder each have their own, and
  the choice outlasts a daemon restart. A rename in the sidebar takes the color along; one from the `herdr` CLI leaves
  the workspace automatic. A worktree open under its main checkout takes that checkout's color and offers no swatches. A workspace
  with no local folder, such as one on a remote host, has none either.
- A value that is not one of the six is a warning, and that workspace keeps its automatic color.

Tabs differ. A tab has no automatic hue: it stays plain until its right-click menu's swatches give it a faint tint, and
None takes that away. The choice is not a setting and is not in this file, as a tab has nothing lasting to key it by: its
name changes, and a restarted daemon may hand an old tab id to a new tab. The window keeps it in `localStorage` under the
daemon's boot and the tab id, the way it keeps pins, so it survives reloading the window but not a daemon restart, and a
tab moved to another workspace, which is a new tab to Herdr, loses it. The slot's name is stored here too, so a tab
follows the theme.

## Themes

A `theme` value is resolved as herdr-gpui resolves its own, so one value works in both apps:

1. **A built-in name**, one of eight: `Herdr Night` (this app's, the default), `Catppuccin Latte`,
   `Catppuccin Mocha`, `Dracula`, `GitHub Light Default`, `Gruvbox Material Dark`, `Nord` and `TokyoNight`. All but
   the first are herdr-gpui's too (see `src/themes/NOTICE.md`).
2. **A Ghostty theme name**, the first file of that name in `~/.config/herdr/themes`, `~/.config/ghostty/themes`,
   `$GHOSTTY_RESOURCES_DIR/themes`, `/Applications/Ghostty.app/Contents/Resources/ghostty/themes`, then the XDG
   data folders' `ghostty/themes`.
3. **A path**, absolute or starting `~/`, to a Ghostty theme file. Only the path the file names is read.
4. **`light:NAME,dark:NAME`**, Ghostty's syntax, follows the macOS appearance and switches live with it. Each side
   is any of the above.

herdr-gpui ships more themes than these. To use another of its names here, put its Ghostty file in
`~/.config/herdr/themes`. Installed themes join the Settings list, which gains a search box when there are any.

A theme that cannot be found or parsed shows Herdr Night, with a warning. The file format is Ghostty's: `background`,
`foreground`, `cursor-color` and `palette = N=#rrggbb`; other keys are ignored, and a color that does not parse
refuses the file.

The chrome is derived from the theme (`src/themes/chrome.ts`, ported from herdr-gpui): surfaces are blends of the
background toward the foreground, and the status colors (working blue, blocked red, done green, the lantern from the
cursor or yellow, the team's magenta) come from the palette. Those, the muted text and each workspace's hue are moved
just far enough to read as words, 4.5:1, on the background, the sidebar and a selected row; line numbers get 3:1. A solid
fill of any of them holds words in the background color at the same ratio. Terminal cells always keep the colors their program asked for. Herdr Night keeps its own
hand-drawn chrome.

## Workspace groups

A workspace's right-click menu has Move to Group: an existing group, New Group…, which names one in place at the top of
the list, or Remove from Group. It writes `workspace_groups`, keyed by folder and name as `workspace_colors` is, and the
value is the group's name, so a group exists while a workspace is in it.

```toml
[workspace_groups]
"/Users/me/code/notes#notes" = "Life"
"/Users/me/code/app#app" = "Work"
```

- Workspaces in no group come first, without a header; then each group, in the order of its first workspace, under a
  header. A click on the header folds or unfolds the group. Its right-click has Show Only This Group (folds the others),
  Show All Groups, Rename Group… and Ungroup, which takes every workspace out and closes none.
- A folded group hides all its workspaces, the focused one too. Its header shows a folder icon, how many are hidden
  and its agents' tally, so an agent waiting on you is still a mark there. Which groups are folded is the window's, not
  the file's.
- Groups show only when sorting by hand. Sorting by attention answers "what needs me", so the list goes flat.
- A worktree goes where its main checkout goes. A workspace with no local folder, such as one on a remote host, can't
  be grouped. A rename in the sidebar takes the group along.
- Dragging reorders within the daemon's list as before; it does not move a workspace between groups.

## Todoist projects

`[todoist.projects]` maps Todoist projects to repo folders. The folder is a workspace's main checkout, so a worktree
or a split-off workspace on that repo counts too.

```toml
[todoist]
filter = "today | overdue"

[todoist.projects]
Herdr = "~/code/herdr-miura"
"Wind Hunter" = "~/code/wind-hunter"
```

- When the focused workspace's folder is mapped, the Todoist panel lists only the tasks for it, with **This repo** and
  **All** in its head. When it isn't, the panel lists every task as before. `todoist.filter` still decides which tasks
  are read at all.
- A task labelled `@repo:<name>` goes to that repo whatever its project: `<name>` is a project in the table, or the
  last part of a mapped folder or an open workspace's folder (`@repo:herdr-miura`). A label that names nothing known
  leaves the task in no repo, rather than falling back to its project.
- A task opened from the panel whose repo is another open workspace's offers **New tab there** and **Queue there**,
  beside the usual buttons, which send to the focused workspace.
- An entry that isn't a full or `~` path is a warning, and its tasks go to no repo.
