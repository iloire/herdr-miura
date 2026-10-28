# Architecture

```
 Herdr daemon ──socket──▶ herdr-client worker ──events──▶ pump thread ──Channel(JSON)──▶ webview
  (owns PTYs)            (herdr-gpui crate,              (connection.rs)                 Controller → Grid → Painter
                          bincode, framing)                                               React: Sidebar, TabBar, …
 Herdr daemon ◀──────── bounded command queue ◀──────── Tauri commands ◀── invoke() ──── Daemon (daemon.ts)
```

## Rust: `src-tauri/src`

| File | Job |
| --- | --- |
| `connection.rs` | Owns the `ClientHandle`, drains `ClientEvent`s on a pump thread, and forwards them as tagged JSON. Keeps the latest snapshot for catalog commands. Writes OSC 52 clipboard text itself. |
| `frame.rs` | Turns each reconstructed `PaneSurfaceFrame` into a `FrameUpdate`: every row after a size or boot change, otherwise only the rows that changed. Cells are positional tuples to keep payloads small. |
| `commands.rs` | The Tauri commands: `connect`, `disconnect`, `resize`, `set_focus`, `send_input`, `send_popup_input`, `request` (an allowlist of endpoint methods), `run_command` (a herdr-commands catalog entry, resolved against the latest snapshot), `catalog`. |
| `changes.rs` | The Changes panel's reads through `herdr-vcs`: `checkout_changes(directory)` (branch, ahead/behind, up to 50 files with line counts, recent commits) and `file_diff(checkout, path, untracked)` (`git diff HEAD`, capped at 1 MiB, or an untracked file's text). Also `change_counts(directories)`, the sidebar's per-workspace changed-file count: one `git status --porcelain` per directory, at most 64. Runs on Tauri's blocking pool with a 5 s deadline, refuses paths that leave the checkout, and never contacts a remote. |
| `osc52.rs` | Bounded base64 to UTF-8 decoding for the daemon's clipboard writes. |
| `error.rs` | The crate's `thiserror` enum. It serializes as its message at the webview boundary. |

None of the commands block: each one queues on `herdr-client`'s bounded queue. A reconnect replaces the
handle, and the old worker stops on its own thread.

`herdr-client` and `herdr-commands` come from herdr-gpui by git commit (`src-tauri/Cargo.toml`). To follow
upstream protocol changes, bump `rev` and run `npm run check`.

## TypeScript: `src`

| File | Job |
| --- | --- |
| `protocol.ts` | Types that mirror Herdr's serde JSON (snake_case fields, externally tagged input enums) and the bridge's events. |
| `daemon.ts` | `invoke` wrappers. Each `connect` opens a new `Channel` and drops events from older ones. |
| `app/controller.ts` | The state store React reads through `useSyncExternalStore`, input routing (to a popup if one is open, otherwise to the focused pane), and the window-only commands (palette, sidebar, font size, reconnect, detach). |
| `terminal/grid.ts` | Applies `FrameUpdate`s and reports dirty rows. Looks up panes and splits by cell. |
| `terminal/painter.ts` | Canvas 2D painter: backgrounds, glyphs, underline and strike, cursor shapes, centered popups. |
| `terminal/boxdraw.ts` | Line-drawing characters drawn as rectangles so borders join up. |
| `terminal/theme.ts` | The cell color encoding (named 0..=16, indexed `0x01..XX`, RGB `0x02RRGGBB`) and modifiers, ported from herdr-gpui. |
| `terminal/keys.ts` | Maps a `KeyboardEvent` to a `ClientPaneInputEvent`, and parses and matches GPUI-style shortcuts. |
| `terminal/mouse.ts` | Wheel events (one event for scrollback, one per line for apps) and the paste bound. |
| `app/attention.ts` | Agent status from the snapshot: each workspace's agents sorted blocked, done, working, idle; how many wait on you; the Dock badge count (blocked + done); and each agent's name and caption. |
| `changes/diff.ts` | Parses unified diffs into numbered hunks, and strips control and direction-override characters from the untrusted lines. |
| `changes/counts.ts` | Picks each workspace's directory (its active tab's first pane) and reads their changed-file counts, one call for all; `App` polls it every 10 s. |
| `changes/store.ts` | Reads the checkout under the focused pane, one read at a time, keeping a request that arrives mid-read for next. |
| `components/` | React views. `StatusMark.tsx` draws herdr-gpui's status icons (a turning orbit, a lantern count badge, a check ring, a hollow ring) as inline SVG. `Terminal.tsx` owns the canvas and a hidden textarea that holds focus, so IME and paste work natively. |

## Input rules carried over from herdr-gpui

- Plain printable text goes through the textarea's `input` event as `TextCommit`, never through keydown. That
  keeps keyboard layouts, dead keys, and IME composition working.
- Ctrl and Option chords send the physical key (`Option-P` sends Alt+`p`, not `π`).
- Cmd chords belong to the app: catalog shortcuts run as commands, and Cmd-V pastes.
- When a pane reports the mouse or is on the alternate screen, the wheel sends one event per line.
  Otherwise it sends one event carrying the whole count, which Herdr scrolls the scrollback by.

## Adding things

- **A daemon action**: if herdr-commands already has it, call `controller.run(name)`. Otherwise add the
  method to `METHODS` in `commands.rs` and call `controller.request(method, params)`.
- **A window-only command**: handle it in `Controller.run` and add it to `WINDOW_COMMANDS`.
- **UI**: write React components in `src/components`. They hot-reload under `npm run tauri dev`.
