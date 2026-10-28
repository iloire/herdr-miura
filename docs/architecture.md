# Architecture

```
 Herdr daemon ──socket──▶ herdr/ worker ──events──▶ pump thread ──Channel(JSON)──▶ webview
  (owns PTYs)            (reader + session       (connection.rs)                 Controller → Grid → Painter
                          threads, bincode)                                       React: Sidebar, TabBar, …
 Herdr daemon ◀──────── bounded command queue ◀──────── Tauri commands ◀── invoke() ──── Daemon (daemon.ts)
```

## Rust: `src-tauri/src`

| File | Job |
| --- | --- |
| `herdr/` | Our client of the daemon. `wire.rs` and `endpoint.rs` are Herdr 0.9.5's declarations (see `herdr/NOTICE.md`); `codec.rs` frames them; `socket.rs` finds the socket by Herdr's rules; `session.rs` holds the handshake, boot and revision fencing, and one API request in flight with a FIFO queue behind it; `surface.rs` validates frames and applies patches whole or not at all; `client.rs` runs a reader thread and a session thread per connection. The optional surface encodings are never requested, so surfaces arrive whole or as row patches. |
| `connection.rs` | Owns the `ClientHandle`, drains its `Event`s on a pump thread, and forwards them as tagged JSON. Writes OSC 52 clipboard text itself. |
| `frame.rs` | Turns each reconstructed `PaneSurfaceFrame` into a `FrameUpdate`: every row after a size or boot change, otherwise only the rows that changed. Cells are positional tuples to keep payloads small. |
| `commands.rs` | The Tauri commands: `connect`, `disconnect`, `resize`, `set_focus`, `send_input`, `send_popup_input`, `request` (an allowlist of endpoint methods: the webview's own and those `src/app/catalog.ts` builds). |
| `git.rs` | Runs Git for reads: no prompts, optional locks, or file monitor, under a deadline and an output cap, with both pipes drained. |
| `changes.rs` | The Changes panel's reads, parsed from Git's porcelain output in `changes/parse.rs`: `checkout_changes(directory)` (branch, ahead/behind, up to 50 files with line counts, recent commits) `commit_files(checkout, sha)` (the files a commit changed, with line counts, up to 300) and `file_diff(checkout, path, untracked, commit)` (`git diff HEAD`, or `git show <commit>` against its first parent, capped at 1 MiB, or an untracked file's text). A commit is taken only by its full 40- or 64-digit name, so Git cannot read it as an option or a range. Also `change_counts(directories)`, the sidebar's per-workspace changed-file count: one `git status --porcelain` per directory, at most 64. Runs on Tauri's blocking pool with a 5 s deadline, refuses paths that leave the checkout, and never contacts a remote. |
| `folder.rs` | A workspace folder's right-click actions: `open_folder(path, with)` in the file manager, VS Code, or GitHub Desktop (a fixed list, never a program the webview names), and `copy_path(path)`. Both refuse anything but an existing absolute directory. |
| `tab_move.rs` | `move_tab(panes, workspace_id, label)`: Herdr does not offer `pane.move` to GUI clients, so this runs the `herdr` CLI (found on `PATH` or the usual install directories) as herdr-gpui does. The first pane opens a new tab in the destination, the rest join it, and a named tab keeps its name. Herdr's own error message comes back as the failure. |
| `osc52.rs` | Bounded base64 to UTF-8 decoding for the daemon's clipboard writes. |
| `error.rs` | The crate's `thiserror` enum. It serializes as its message at the webview boundary. |

None of the commands block: each one queues on the connection's bounded queue. A reconnect replaces the
handle, and the old worker stops on its own thread.

When Herdr changes its protocol, follow `src-tauri/src/herdr/NOTICE.md`: copy the changed declarations
from that release and run the live test against a daemon of that version.

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
| `app/pins.ts` | Pinned tabs, kept by the window (Herdr has none) and keyed by daemon boot. A pin also moves the tab to the front with `tab.move`, so the daemon's order matches the strip. |
| `app/attention.ts` | Agent status from the snapshot: each workspace's agents sorted blocked, done, working, idle; the workspace card's marks, one per live status (blocked with its count, working, done; idle only when nothing else is), so a finished agent never hides a working one; the Dock badge count (blocked + done); and each agent's name and caption. |
| `app/workspaceOrder.ts` | The sidebar's workspace order, kept by the window: by hand, the daemon's own list, which dragging a row reorders with `workspace.move` (pointer events, since Tauri's file drop swallows HTML drag and drop); or by attention, blocked, done, working, idle, stable within a status. |
| `changes/diff.ts` | Parses unified diffs into numbered hunks, and strips control and direction-override characters from the untrusted lines. |
| `changes/counts.ts` | Picks each workspace's directory (its active tab's first pane) and reads their changed-file counts, one call for all; `App` polls it every 10 s. |
| `changes/store.ts` | Reads the checkout under the focused pane, one read at a time, keeping a request that arrives mid-read for next. |
| `changes/useCommitFiles.ts` | Reads the files of the commit open in the Changes panel, once, since a commit never changes. |
| `components/` | React views. `ContextMenu.tsx` is the shared right-click menu (arrow keys, nested pages, kept inside the window). `StatusMark.tsx` draws herdr-gpui's status icons (a turning orbit, a lantern count badge, a check ring, a hollow ring) as inline SVG. `Terminal.tsx` owns the canvas and a hidden textarea that holds focus, so IME and paste work natively. |

## Input rules carried over from herdr-gpui

- Plain printable text goes through the textarea's `input` event as `TextCommit`, never through keydown. That
  keeps keyboard layouts, dead keys, and IME composition working.
- Ctrl and Option chords send the physical key (`Option-P` sends Alt+`p`, not `π`).
- Cmd chords belong to the app: catalog shortcuts run as commands, and Cmd-V pastes.
- Option-arrows are the app's too, as Herdr's `[keys]` bind them: Up and Down step through workspaces
  (wrapping, window-side in `app/step.ts`), Left and Right through tabs. Text fields keep them for word moves.
- When a pane reports the mouse or is on the alternate screen, the wheel sends one event per line.
  Otherwise it sends one event carrying the whole count, which Herdr scrolls the scrollback by.

## Adding things

- **A command**: add it to `DEFINITIONS` in `src/app/catalog.ts` with its keys and the request it builds,
  and allow its method in `METHODS` in `commands.rs`. A one-off daemon call from a view can use
  `controller.request(method, params)` directly.
- **A window-only command**: give it `action: "window"` in the catalog and handle it in `Controller.run`.
- **UI**: write React components in `src/components`. They hot-reload under `npm run tauri dev`.
