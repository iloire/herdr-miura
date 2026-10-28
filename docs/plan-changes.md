# Plan: Changes panel and diff view

Shows what changed in the checkout you are working in, and the diff of any file, without leaving the app.
Read-only: commit and push come in the next step.

## Where the data comes from

- **Which checkout**: the focused pane's `foreground_cwd` (falling back to `cwd`) from the daemon snapshot.
  The panel follows you as you move between panes and workspaces.
- **Backend**: our own Git reads (`src-tauri/src/git.rs`, `changes.rs`); originally `herdr-vcs` from herdr-gpui.
  - `changes::locate` + `changes::read` give the branch, upstream, ahead/behind, commits the default branch
    lacks, up to 50 changed files with line counts, and the latest 5 commits.
  - `Session::git_bytes` runs `git diff HEAD -- <file>` with a 1 MiB cap. An untracked file is read with
    `Session::read_text`, which is capped at 1 MiB and refuses binaries and symlinks, and is shown as all
    added.
- All Git runs on Tauri's blocking pool, each read has a 5 s deadline, and nothing contacts a remote.

## Steps

1. ~~Rust `changes.rs`: `checkout_changes(directory)` and `file_diff(checkout, path, untracked)` commands
   that return plain JSON, with typed errors folded into the crate's `Error`.~~ ✅
2. ~~TS `changes/diff.ts`: parse a unified diff into hunks and numbered lines. Diff text is untrusted, so
   control and direction-override characters are stripped and lines are bounded. Tested with Vitest.~~ ✅
3. ~~TS `changes/store.ts`: follows the focused directory, reloads when it changes, when the window regains
   focus, and every 5 s while the panel is open, and never runs two reads at once.~~ ✅
4. ~~Changes panel: a right-hand drawer that slides in and out, toggled by the catalog's `review_changes`
   shortcut and a tab-bar button. It shows the branch line, files with their status letter and +/-, and
   recent commits.~~ ✅
5. ~~Diff view: covers the terminal area (the terminal stays mounted, so the daemon sees no resize), shows
   the diff inline with old and new line numbers, steps through files with ↑/↓, and closes with Esc.~~ ✅
6. ~~Check it in the real app against a demo repository, and update the README and architecture doc.~~ ✅
7. ~~Commit diffs, as herdr-gpui's Changes: picking a recent commit lists the files it changed under it,
   and picking one opens the diff view on that file's change in the commit (against its first parent, or
   the empty tree for a root commit), ↑/↓ stepping through the commit's files.~~ ✅

## Later, not in this step

Syntax highlighting (Shiki), side-by-side view, word-level emphasis, staging, commit, push,
and pull requests (`herdr-github`).

## Ideas from codeflow (gimenete/codeflow)

An Electron + React IDE with Git, GitHub pull requests, and Claude built in (MIT, last active Feb 2026).
Worth borrowing:

- **`@pierre/diffs`** for the diff view: unified and split styles, line selection, and line annotations,
  which it uses to put Stage / Unstage / Discard buttons on each hunk. Replaces our own table renderer
  once we want split view and hunk staging.
- **Hunk staging and discard** from the diff, not just whole files.
- **Select lines in a diff and ask the agent about them**: sends a pane the file and range as context.
- **Pull requests with their timeline**: comments, reviews, and checks, with saved searches across
  repositories. On our side this comes from `herdr-github`.
- **Several GitHub accounts**, switched from the sidebar (`herdr-github` already supports them).
- **A file watcher** (chokidar there; `notify` in Rust for us) instead of a 5 s poll, so the panel updates
  the moment an agent writes a file.
- **Multiple windows** kept in sync.

Not for us: its Claude chat built on the Agent SDK. Herdr runs agents in panes, and `herdr-acp` already
covers a chat view.
