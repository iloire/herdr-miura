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
| `herdr/` | Our client of the daemon. `wire.rs` and `endpoint.rs` are Herdr 0.9.5's declarations (see `herdr/NOTICE.md`); `codec.rs` frames them; `socket.rs` finds the socket by Herdr's rules; `session.rs` holds the handshake, boot and revision fencing, and one API request in flight with a FIFO queue behind it; `surface.rs` validates frames and applies patches whole or not at all; `client.rs` runs a reader thread and a session thread per connection. The optional surface encodings are never requested, so surfaces arrive whole or as row patches. `ssh.rs` and `health.rs` reach another machine's daemon instead: see [ssh.md](ssh.md). |
| `ssh_hosts.rs` | The host picker's list (named `Host` entries of `~/.ssh/config` and its includes) and host key approval: `scan_host_key` fetches a new host's keys and returns their fingerprints, `trust_host_key` writes exactly those keys to known_hosts. |
| `connection.rs` | Owns the `ClientHandle`, drains its `Event`s on a pump thread, and forwards them as tagged JSON. Writes OSC 52 clipboard text itself. |
| `frame.rs` | Turns each reconstructed `PaneSurfaceFrame` into a `FrameUpdate`: every row after a size or boot change, otherwise only the rows that changed. Cells are positional tuples to keep payloads small. |
| `commands.rs` | The Tauri commands: `connect` (to this machine, or a `host` over SSH), `disconnect`, `resize`, `set_focus`, `send_input`, `send_popup_input`, `request` (an allowlist of endpoint methods: the webview's own and those `src/app/catalog.ts` builds). |
| `git.rs` | Runs Git for reads: no prompts, optional locks, or file monitor, under a deadline and an output cap, with both pipes drained. |
| `changes.rs` | The Changes panel's reads, parsed from Git's porcelain output in `changes/parse.rs`: `checkout_changes(directory)` (branch, ahead/behind, up to 50 files with line counts, recent commits) `commit_files(checkout, sha)` (the files a commit changed, with line counts, up to 300) and `file_diff(checkout, path, untracked, commit)` (`git diff HEAD`, or `git show <commit>` against its first parent, capped at 1 MiB, or an untracked file's text). A commit is taken only by its full 40- or 64-digit name, so Git cannot read it as an option or a range. Also `change_counts(directories)`, the sidebar's per-workspace changed-file count: one `git status --porcelain` per directory, at most 64. Runs on Tauri's blocking pool with a 5 s deadline, refuses paths that leave the checkout, and never contacts a remote. |
| `files.rs` | The Files panel's reads: `list_files(directory)` (every file `git ls-files` lists, tracked and untracked but not ignored, up to 50,000) and `read_file(root, path)` (a text file up to 1 MiB, an image up to 8 MiB as base64, or why it cannot be shown). A path is resolved through symlinks and refused when it leaves the checkout. |
| `folder.rs` | A workspace folder's right-click actions: `open_folder(path, with)` in the file manager, VS Code, or GitHub Desktop (a fixed list, never a program the webview names), and `copy_path(path)`. Both refuse anything but an existing absolute directory. |
| `claude_usage.rs` | `claude_usage()`: this Mac's Claude plan usage (5-hour and weekly windows, plan name), read with Claude Code's own OAuth sign-in from the login keychain or `~/.claude/.credentials.json` and asked of Anthropic's `oauth/usage` endpoint, as herdr-gpui's `herdr-usage` Claude provider does. A reading is kept 10 min (30 min after a 429, 5 min after another failure), so the webview may poll freely. Works whichever host the window is attached to: the account is the user's. |
| `session_usage.rs` | `session_usage(sessions)`: each Claude Code session's token use, for the tab header. A session's pane carries its id as the `claude_session` token (dotfiles' `herdr-attention`, from Claude Code's `SessionStart` and `UserPromptSubmit` hooks; not the path, since Herdr cuts a token at 80 characters), so its transcript is found as `~/.claude/projects/*/<id>.jsonl` and remembered. Each response's `usage` is summed by minute over six hours, a response written twice counting once with its last copy, subagents' `<id>/subagents/*.jsonl` included; the last main-thread response gives the model and the context. Files are read on from where the last poll stopped. Ids that are not UUIDs are refused, so a pane cannot point it at another file. This machine only. |
| `listening_ports.rs` | `listening_ports()`: the TCP ports each workspace's servers listen on, as herdr-gpui shows them. One `sh` step (ported from herdr-gpui) lists listeners with `lsof` (`ss` on Linux) and reads each listener's environment, or its nearest parent's, for the `HERDR_WORKSPACE_ID` every Herdr pane exports; its `HERDR_SOCKET_PATH` must name the daemon we are attached to. Listeners started outside Herdr are dropped. This machine only, under a 15 s deadline. |
| `worktrees.rs` | `worktrees(directories)`: the linked worktrees of each workspace's checkout, the main one left out, from `git worktree list --porcelain -z` run in the workspace's folder, so worktrees an agent made under `.claude/worktrees/` count although no pane sits in them. Bare and pruned ones are skipped. Each reports its branch, its last commit's subject and time, the commits the remote's default branch lacks (`changes.rs`'s `default_branch`, named in `base`) and its changed files. At most 16 per checkout, under a 5 s deadline per checkout, this machine only. |
| `tab_move.rs` | `move_tab(panes, workspace_id, label)`: Herdr does not offer `pane.move` to GUI clients, so this runs the `herdr` CLI (found on `PATH` or the usual install directories) as herdr-gpui does. The first pane opens a new tab in the destination, the rest join it, and a named tab keeps its name. Herdr's own error message comes back as the failure. |
| `team.rs` | `start_team(workspace_id, directory, members)`: opens a tab per team member, named after its role, with `herdr tab create`, then types `claude --agent <agent>` into its pane with `herdr pane run`, using `tab_move.rs`'s CLI helpers. Role and agent names are refused unless they are plain words. `create_team(directory)` writes the starter team from `templates/team/` (New Team on a workspace's right-click), never over an existing file. This machine only. See [team.md](team.md). |
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
| `terminal/links.ts` | Finds the URL under a cell (http(s), or a bare `localhost:port`), within its pane and across wrapped rows. ⌘-hover underlines it, ⌘-click opens it in the browser. |
| `app/closing.ts` | Closing a tab hides it at once. Herdr answers `tab.close` only after the tab's process has exited, which takes 300–600 ms for one that traps SIGHUP, as agents and dev servers do. The controller leaves closing tabs and their panes out of the snapshot it renders. Closing the focused tab focuses the one Herdr would pick (the one before it, or after it for the first) before sending the close. A refused close brings the tab back. |
| `app/pins.ts` | Pinned tabs, kept by the window (Herdr has none) and keyed by daemon boot. A pin also moves the tab to the front with `tab.move`, so the daemon's order matches the strip. The set lives in `App`, so the sidebar marks each workspace card that has pinned tabs. |
| `app/attention.ts` | Agent status from the snapshot: each workspace's agents sorted blocked, done, working, idle; the workspace card's marks, one per live status (blocked with its count, working, done; idle only when nothing else is), so a finished agent never hides a working one; how many agents each tab holds, which a tab with more than one shows as a terminal mark and the number, as a workspace card does; the Dock badge count (blocked + done); each agent's name and caption; and the loop tag of a Claude session `/loop` will run again. Herdr has no idea of a loop, so that tag is the `attn_loop` token dotfiles' `herdr-attention` reports on the agent's pane from Claude Code's `ScheduleWakeup` / `CronCreate` / `CronDelete` hooks, and `LoopMark.tsx` draws it as a ↻ on the tab and the workspace card, with the next wakeup on hover. |
| `app/workspaceOrder.ts` | The sidebar's workspace order, kept by the window: by hand, the daemon's own list, which dragging a row reorders with `workspace.move` (pointer events, since Tauri's file drop swallows HTML drag and drop); or by attention, blocked, done, working, idle, stable within a status. |
| `app/ports.ts` | Reads `listening_ports`; `App` rescans every 5 s while attached to this Mac. `components/Ports.tsx` draws a globe and `:3000 :5173`, each opening its page in the browser, under each workspace card and, for the focused workspace, in the status bar. |
| `app/sessionUsage.ts` | Polled every 15 s for every session in the snapshot. Weights tokens as fresh input (output ×5, cache writes ×1.25 for 5 min and ×2 for 1 h, cache reads ×0.1), since raw counts rank sessions by the cache reads every turn repeats; sums them from the start of the plan's 5-hour window (its reset less five hours, so it counts what the status bar's meter counts); and buckets the last 15 minutes for the burn chart. `components/TabHeader.tsx` draws the strip over the focused tab's terminal: per agent its status, model, context, spend this window and burn, and a loop's next tick. A tab without agents has no header. |
| `app/claudeUsage.ts` | Reads `claude_usage` every minute and counts down to each window's reset. `components/ClaudeUsage.tsx` draws `✳ ▬ 9% 4h 30m ▬ 34% 4d 11h` on the app-wide (left) half of the status bar, amber from 75 %, red from 90 %, with the plan and reset times on hover. |
| `app/team.ts` | Reads and checks each workspace's `.herdr/team.json` (again when the window comes back), and matches each role to the tab of that name and its most urgent agent. `components/TeamSection.tsx` lists them under the workspace list, with a Start button for the roles not running; every card with a team shows a violet team mark, `3` or `2/3` running. See [team.md](team.md). |
| `changes/diff.ts` | Parses unified diffs into numbered hunks, and strips control and direction-override characters from the untrusted lines. |
| `changes/counts.ts` | Picks each workspace's directory (its active tab's first pane) and reads their changed-file counts, one call for all; `App` polls it every 10 s. |
| `changes/worktrees.ts` | Reads `worktrees` in the same round as the counts. `components/Worktrees.tsx` draws `⑂3` at the end of the card's branch line and beside the focused workspace in the status bar: muted once every worktree is merged and clean, green while any still holds unmerged commits or changed files. Hovering lists each one with what is pending in it; clicking opens `components/WorktreesDialog.tsx`, the live list in full: each worktree's branch, unmerged commits and uncommitted files, last commit and path, with New tab here (`tab.create` with its `cwd`), VS Code, Folder and Copy path. |
| `changes/store.ts` | Reads the checkout under the focused pane, one read at a time, keeping a request that arrives mid-read for next. |
| `changes/useCommitFiles.ts` | Reads the files of the commit open in the Changes panel, once, since a commit never changes. |
| `changes/useCommitDiffs.ts` | Reads every file's diff in that commit for `CommitDiffView`, in list order, four at a time, so the first files show while a large commit is still being read. |
| `files/tree.ts` | The Files panel's tree, ported from herdr-gpui's `files/tree.rs`: folders first, each counting the changed files under it, the rows open folders show, and the rows a filter matches (a name, or the whole path once the query holds `/`). |
| `files/listing.ts` | Lists the checkout under the focused pane while the Files panel is open, again when the window comes back, and reads one file for the file view. |
| `components/` | React views. `ContextMenu.tsx` is the shared right-click menu (arrow keys, nested pages, kept inside the window). `StatusMark.tsx` draws herdr-gpui's status icons (a turning orbit, a lantern count badge, a check ring, a hollow ring) as inline SVG. `Terminal.tsx` owns the canvas and a hidden textarea that holds focus, so IME and paste work natively. `DiffView.tsx` shows one uncommitted file's diff; `CommitDiffView.tsx` shows a whole commit, every file one after another under a sticky name, and both draw hunks with `DiffBody.tsx`. |

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
