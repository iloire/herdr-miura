# Plan: Changes panel and diff view

Shows what changed in the checkout you are working in, and the diff of any file, without leaving the app.
It keeps a branch in step with its remote too: background fetch, push, publish and pull, with the
commits each would move. You can discard one file's change, which goes to the Trash first and is refused if
the file moved since you looked ([plan-git-actions.md](plan-git-actions.md)). It does not stage, commit, stash,
merge or rebase. Agents do the committing here, and a stash could destroy another agent's work.

## Where the data comes from

- **Which checkout**: the focused pane's `foreground_cwd` (falling back to `cwd`) from the daemon snapshot.
  The panel follows you as you move between panes and workspaces.
- **Backend**: our own Git reads (`src-tauri/src/git.rs`, `changes.rs`); originally `herdr-vcs` from herdr-gpui.
  - `changes::locate` + `changes::read` give the branch, upstream, ahead/behind, commits the default branch
    lacks, up to 50 changed files with line counts, and the latest 50 commits.
  - `Session::git_bytes` runs `git diff HEAD -- <file>` with a 1 MiB cap. An untracked file is read with
    `Session::read_text`, which is capped at 1 MiB and refuses binaries and symlinks, and is shown as all
    added.
- All Git runs on Tauri's blocking pool. Each read has a 5 s deadline and `changes.rs` contacts no remote;
  everything that does is in `sync.rs`, with a 60 s limit (see [Remote sync](#remote-sync)).

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
8. ~~The whole commit at once: picking a recent commit opens every file's diff in the main pane, one
   after another under a sticky file name, so a commit reads without opening each file. Its files
   still list under it in the panel, and picking one scrolls the diff to it; ↑/↓ jump between files.~~ ✅
9. ~~Remote sync: background fetch, Push, Publish, Pull, and the commits that would move.~~ ✅
10. ~~The commit in the main area: rows stay one line and the list grows to 50, and the whole message,
    author, date, full name and files sit above the diffs. ↑/↓ step through the commits from there, k/j
    through the files.~~ ✅

## Remote sync

`git status` counts ↑/↓ against the last fetch that ran in the checkout, so ↓0 means little on its own.
Fetch comes first for that reason, and everything else leans on it.

- **Fetch** runs while the Changes panel is open: when it opens or moves to another checkout, when the
  window comes back, and every 3 minutes, at most once a minute per checkout. The panel says when
  (`fetched 2m ago`) and goes by this app's own fetches, so a relaunch starts from nothing until the
  first one lands. A failed fetch is `fetch failed`, with Git's line on hover, and nothing else changes.
  It leaves `FETCH_HEAD` alone, since an agent may be about to merge it, and skips Git's auto maintenance.
- **Each count opens what would move, and the word beside it moves it.** `↑27` lists the outgoing commits
  (`@{upstream}..HEAD`), and **Push** beside it pushes; `↓3` and **Pull** are the same for incoming. So
  looking can never push. The list uses the same rows as Recent commits, opens the same diff view, and
  stops at 500 commits. The lists read local refs under the usual 5 s deadline, as far as the last
  fetch knows.
- **Push** is `git push --porcelain`, so the ref Git refused can be read from stdout. A rejection shows
  Git's reason and offers Pull, and fetches so ↓ shows what arrived. A non-fast-forward rejection means
  the branches have diverged, so that Pull is then refused too, and says so.
- **Publish** replaces Push on a branch with no upstream, when an `origin` exists: `git push -u origin <branch>`.
- **Pull** is `git pull --ff-only --no-rebase --no-autostash`. `--ff-only` alone is not enough:
  `merge.autoStash` still stashes a dirty tree with it, and a stash could hold another agent's work. Diverged
  branches are refused and left as they were, and the note says so. So is a pull whose incoming commits
  touch a file with uncommitted changes.
- **Never force.** The panel has no such option, and it refuses to push when a `+` refspec under
  `remote.<name>.push` or `remote.<name>.mirror` would make a plain push force.
- **One operation per checkout**, held in `sync::Running` on the Rust side by the checkout's root, and in
  `SyncStore` so the panel does not ask twice. All the buttons disable while one runs, a background
  fetch included, and the running state replaces the fetch time.
- **Hidden** on a detached HEAD, during a rebase or merge (found through `--git-path`, since in a linked
  worktree those files are not under `.git/`), on an unborn branch, with no remote, and when the upstream
  is gone. The panel's view is up to 5 s old, so the backend checks the branch and any rebase or merge again
  just before it runs, and a checkout that has moved off the branch on show is left alone.
- **On a remote host** all of it stays hidden. The panel has no checkout there at all, since
  `checkout_changes` is refused ([ssh.md](ssh.md)). `sync_checkout` and `moving_commits` are refused the same
  way, and the panel gets no sync store, so a checkout read before switching hosts offers nothing either.

`git.rs`'s `supervised` differs from the runner the reads use: `ssh`, transport helpers, the `fetch` inside a
`pull` and hooks share Git's process group, so an overrun stops them all with SIGTERM first, which lets Git
remove its lock files, and SIGKILL after 2 s. It keeps the end of each stream, since Git prints its reason
last, after whatever a hook said, and keeps the lines. A hook's background job holding a pipe cannot
hold the panel up.

Known limits: the counts and lists go by the upstream, so with a `pushRemote` that differs from it, they
do not describe what a push moves. Under `push.default=simple` a branch tracking another name
(`git worktree add -b feat/x origin/main` makes one) is refused by Git, which the note shows; publish it
under its own name from a terminal. A hook slower than 60 s is stopped.

## Later, not in this step

Syntax highlighting in the diff views (Shiki, through `files/offThread.ts` as the file view does),
side-by-side view, word-level emphasis, staging, commit, and pull requests (`herdr-github`).

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
