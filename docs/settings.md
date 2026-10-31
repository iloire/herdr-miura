# Settings

Herdr Miura reads `~/.config/herdr/config-tauri.toml` (`$XDG_CONFIG_HOME/herdr/` when that is set), beside
Herdr's `config.toml` and herdr-gpui's `config-gpui*.toml`. It is this app's own file, so it never trips
herdr-gpui's unknown-key warning.

- **Every key is optional.** A missing key, or a missing file, is its default.
- **Nothing fails the load.** A bad value keeps its default, and a key that is not a setting does nothing.
  Both show as a dismissible warning over the terminal, and at the top of the Settings dialog. A file that
  does not parse is all defaults, with the parser's message.
- **The Settings dialog (⌘,, the command palette, or the gear at the right end of the status bar) writes the same file**, one key at a time, keeping comments and layout. A key it
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
| `tabs.wrap` | boolean | `true` | Tabs that do not fit wrap onto more rows. `false` keeps one row, which scrolls sideways with no scrollbar and keeps the open tab and the + in view. |
| `new_tab.command` | string, one line, at most 1024 characters | none | What the tab strip's + and ⌘⇧T type into the new tab's shell, e.g. `"claude"`, as herdr-gpui's `plus_command`. ⌥-click on + or ⌘T always opens a plain shell, and + turns into an outlined terminal icon while ⌥ is held. |
| `workspace_colors` | table of folder to color | none | A workspace's color, chosen in its right-click menu: each key is a workspace's folder, as a full path (a key with `/` or `.` needs quotes in TOML), and each value is `red`, `green`, `yellow`, `blue`, `magenta` or `cyan`. See below. |
| `workspace_cards.git_status` | boolean | `true` | Show the Git counts on every card: ↑ to push, ↓ to pull, ± changed files. |
| `workspace_cards.agent_status` | boolean | `true` | Show the agent status marks and tally on the head of every card. |
| `workspace_cards.details` | `"manual"`, `"auto"`, `"always"` or `"never"` | `"manual"` | When a card's details show. See below. |
| `workspace_cards.compact` | boolean | `false` | Tighter card rows, so more workspaces fit. |

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
"/Users/me/code/notes" = "cyan"

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
- The key is the folder the workspace's card reads, so a choice survives a rename, and two workspaces on one folder
  share it. A worktree open under its main checkout takes that checkout's color and offers no swatches. A workspace
  with no local folder, such as one on a remote host, has none either.
- A value that is not one of the six is a warning, and that workspace keeps its automatic color.

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
