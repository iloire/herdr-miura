# Settings

Herdr Tauri reads `~/.config/herdr/config-tauri.toml` (`$XDG_CONFIG_HOME/herdr/` when that is set), beside
Herdr's `config.toml` and herdr-gpui's `config-gpui*.toml`. It is this app's own file, so it never trips
herdr-gpui's unknown-key warning. On this Mac it is a symlink into dotfiles (`~/dotfiles/herdr/config-tauri.toml`,
linked by ansible-recipes' `herdr_config` role), which lists every key commented out at its default.

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
| `confirm_close_tab` | boolean | `false` | Ask before closing a tab an agent runs in. Herdr reports agents, not other processes, so a tab with only a shell or a server closes without asking. |
| `terminal.font_family` | string | `"JetBrains Mono"` | The terminal's face, followed by `"SF Mono", Menlo, "DejaVu Sans Mono", monospace`. A value with a comma is used as a whole CSS font list. |
| `terminal.font_size` | number, 8 to 32 | `13` | The terminal's size in points. ⌘+ / ⌘- / ⌘0 write it, so the size survives a relaunch; ⌘0 removes the key. |
| `terminal.line_height` | number, 1 to 2 | `1.4` | Row height as a multiple of the size. |
| `ui.font_size` | number, 10 to 18 | `13` | The chrome's text size (sidebar, tabs, panels, dialogs). Every font size in the stylesheet scales by `size / 13`. |
| `new_tab.command` | string, one line, at most 1024 characters | none | What the tab strip's + and ⌘⇧T type into the new tab's shell, e.g. `"claude"`, as herdr-gpui's `plus_command`. ⌥-click on + or ⌘T always opens a plain shell. |

```toml
theme = "light:GitHub Light Default,dark:Herdr Night"
confirm_close_tab = true

[terminal]
font_family = "Iosevka"
font_size = 14
line_height = 1.3

[ui]
font_size = 14

[new_tab]
command = "claude"
```

## Themes

A `theme` value is resolved as herdr-gpui resolves its own, so one value works in both apps:

1. **A built-in name**: `Herdr Night` (this app's, the default), herdr-gpui's hand-written `Default`, `Nord`,
   `Dracula`, `Catppuccin Mocha` and `Catppuccin Latte`, and the 28 Ghostty files herdr-gpui bundles (`TokyoNight`,
   `Gruvbox Dark`, `Rose Pine`, `GitHub Light Default`, …; see `src/themes/NOTICE.md`).
2. **A Ghostty theme name**, the first file of that name in `~/.config/herdr/themes`, `~/.config/ghostty/themes`,
   `$GHOSTTY_RESOURCES_DIR/themes`, `/Applications/Ghostty.app/Contents/Resources/ghostty/themes`, then the XDG
   data folders' `ghostty/themes`.
3. **A path**, absolute or starting `~/`, to a Ghostty theme file. Only the path the file names is read.
4. **`light:NAME,dark:NAME`**, Ghostty's syntax, follows the macOS appearance and switches live with it. Each side
   is any of the above.

A theme that cannot be found or parsed shows Herdr Night, with a warning. The file format is Ghostty's: `background`,
`foreground`, `cursor-color` and `palette = N=#rrggbb`; other keys are ignored, and a color that does not parse
refuses the file.

The chrome is derived from the theme (`src/themes/chrome.ts`, ported from herdr-gpui): surfaces are blends of the
background toward the foreground, and the status colors (working blue, blocked red, done green, the lantern from the
cursor or yellow, the team's magenta) come from the palette, each moved just far enough to read at 3:1 on the
chrome when it would not. Terminal cells always keep the colors their program asked for. Herdr Night keeps its own
hand-drawn chrome.
