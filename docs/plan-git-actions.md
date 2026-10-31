# Plan: Acting on changes from the Changes panel

The Changes panel only looks: it fetches, pushes and pulls, and everything else happens in a terminal. This
adds the small actions you reach for while reading a diff: copy a path, open the file, throw a change away,
commit a few files.

[plan-changes.md](plan-changes.md) ruled this out because "discard or stash could destroy another agent's
work". That risk has not gone away, so this plan keeps the concern and changes the answer: discard is allowed
because it can be undone and it refuses to act on a file that moved since you looked.

## What it adds

| Action | Where | Writes |
| --- | --- | --- |
| Copy Path, Open in VS Code | File row right-click | Nothing |
| Copy SHA | Commit row right-click | Nothing |
| Discard Changes… | File row right-click, button in the diff header | One file, after a confirmation |
| Commit | Tick boxes on file rows, message box under the list | The ticked files |

## What stays out

- **Stage and Unstage.** All agents in a checkout share one index. A file staged from the panel goes into the
  next `git commit` any agent runs, and neither side would see it happen. Commit takes paths instead, so the
  panel never leaves anything staged. A file an agent has staged stays staged and out of the commit.
- **Discard all.** One click must not reach every agent's work.
- **Stash, reset, clean, amend, switching branch, force.** These stay refused for the reasons in
  [plan-changes.md](plan-changes.md).

## Discard

Two commands, as Land has `land_plan` then `land_finish`:

1. **`discard_plan(checkout, path, branch)`** runs when the dialog opens. It reads the status now and returns what a
   discard would do, the line counts, and a fingerprint: the file's raw status entry plus
   `git hash-object --no-filters` of the working file. The entry holds the HEAD and index hashes, so the
   fingerprint covers all three versions.
2. **`discard_file(checkout, path, fingerprint, branch)`** runs on confirm. It takes the checkout's `sync::Running`
   claim, makes the same checks as a sync (`current_branch`: same branch, no rebase or merge under way), and
   reads the fingerprint again. If it differs, nothing happens and the dialog says the file changed. An
   overlapping Git operation fails on `index.lock`; Git's reason is shown, with no retry.

Then, by kind of file:

| File | What happens |
| --- | --- |
| Modified | Copy to Trash, then restore from HEAD |
| Staged new (`A`) | Copy to Trash, then restore, which unstages and deletes it |
| Renamed (`R`) | Copy the new path to Trash, then restore **both paths in one command** |
| Deleted (`D`) | Restore from HEAD; nothing to keep |
| Untracked file (`?`) | Move to Trash |
| Folder, symlink, submodule, conflict | Refused, and the dialog says why |

A plain file on disk at a path the row does not show is saved as well: a staged deletion with the file put back
(`git rm --cached`), or a new file at a rename's old path. A parent that is no longer a folder is refused, since
Git would replace it to make the path. On an unborn branch only an untracked file can be discarded.

The restore is `git --literal-pathspecs restore --source=HEAD --staged --worktree -- <paths>`, run through
`git::supervised`, which is the runner for commands that write.

**The Trash is the undo.** Each discarded file lands there under its own name, so there is no undo state of our
own to build. Tracked files are copied to a temporary file that goes to the Trash, and the working file stays in
place until that has succeeded. If the Trash fails, the discard stops with the file untouched. A staged version
that differs from the working file is not kept. Use the `trash` crate (5.2.9), which also covers Linux and
Windows. On macOS it uses the NSFileManager method.

Checked on 2026-10-31 in a real bundled app, signed ad hoc and started with `open`, so no terminal lent it its
permissions. The crate's default Finder method scripts the Finder through `osascript`: macOS put up
"wants access to control Finder.app" and `osascript` blocked until it was answered, so a discard would hang on a
dialog that can open on another display. NSFileManager took 74 ms with no prompt, and the file was in `~/.Trash`.
The price is that the Trash may not offer Put Back: drag the file out instead, which is all a temporary copy
could use anyway.

The temporary copy is made in a folder inside the Git directory (`rev-parse --absolute-git-dir`). That is the
same volume as the file, so it reaches the same Trash, and no `git status` or agent can see it there.

**Checked in a scratch repo with Git 2.51.** These are why the table looks as it does:

- A plain `git restore -- 'a*'` restored `abc` and `adef` as well. `*` is a legal filename character, so without
  `--literal-pathspecs` a discard can silently take other files with it.
- On a staged new file, `restore --source=HEAD` exits 0 and deletes the file, so the copy must come first.
- On a rename, restoring the new path alone deletes it and leaves the old one deleted: both versions gone from
  the working tree. Both paths in one command brings the file back. `parse::status` skips the old path today
  and has to keep it. The webview need not know: `discard_plan` finds it in the full status, since a
  `status -- <path>` filter would hide the rename.

**The dialog** follows `LandDialog`: `role="alertdialog"`, Cancel takes the focus, so a stray Enter does
nothing. It names the file, the counts, and "A copy goes to the Trash". When `agentRefusal` finds a busy agent
in this checkout it adds that as a warning. It does not refuse, since discarding a running agent's change can
be the very reason you are here, and the fingerprint still guards the moment of the click.

There is no keyboard shortcut. After a discard from the diff, the view moves to the next file, or closes after
the last.

## Commit

A tick box on each file row, unticked by default and forgotten when the file leaves the list, and one on the list's
count for all of them. A message box and a Commit button appear once something is ticked.

`commit_paths(checkout, paths, message, branch)` takes the same claim and checks, then runs:

1. `git --literal-pathspecs add -- <the untracked paths>`
2. `git --literal-pathspecs commit --only -m <message> -- <paths>`, with a rename's old and new paths both
   listed.

Checked in the same scratch repo: `--only` left another file's staged change staged and out of the commit, and
it took an untracked folder once added. It refuses an untracked file that has not been added, hence step 1.
A commit stopped by a hook leaves those files staged, so a failed commit runs
`git --literal-pathspecs restore --staged` on what step 1 added. The note shows the hook's output, and the
message and ticks stay.

Hooks run, signing follows the user's config, and the 60 s limit applies. It is hidden in a merge or rebase, on
a detached HEAD, on an unborn branch and on a remote host. Push stays a separate click.

## Steps

One commit each.

1. ~~**Right-click menus, read-only.** `ContextMenu` on `FileRow` (Copy Path, Open in VS Code through
   `folder::open_file`) and on commit rows (Copy SHA). A deleted file has no Open.~~ ✅
2. ~~**Status keeps what actions need.** `parse::status` keeps a rename's old path and each entry's raw text.
   Rust tests.~~ ✅
3. ~~**Discard backend.** A new `src-tauri/src/worktree_ops.rs`, since `changes.rs` promises it never writes.
   `sync::Running::claim` and `current_branch` become `pub(crate)`. Both commands refuse a remote host with
   `ensure_local`, and paths with a component that is not `Normal`. Rust tests against real repos: each row of
   the table, a glob-named file beside files it must not touch, a stale fingerprint, a rebase under way. Check
   the Trash method in a real build here.~~ ✅
4. ~~**Discard UI.** The menu item, the diff header button, the dialog, moving to the next file, and a reread of
   `ChangesStore` and the sidebar counts. Hidden when `sync` is null, as on a remote host.~~ ✅
5. ~~**Commit backend.** `commit_paths` with Rust tests: an agent's staged file left alone, a glob-named path, an
   untracked folder, a rename, a hook refusing.~~ ✅
6. ~~**Commit UI.** Tick boxes, the message box, the failure note.~~ ✅
7. ~~**Docs.** Update the opening of plan-changes.md and its "Later" list, the README's "never stages, commits"
   line, `docs/architecture.md`, and CHANGELOG.md. Do this in the same commit as step 4 and again with step 6,
   so `main` never says the panel cannot do what it can.~~ ✅
8. ~~**Try it in a dev window** against a demo repo with an agent writing to it, with the `qa` agent: discard each
   kind of file, find the copies in the Trash, and watch a stale discard get refused.~~ ✅

Step 8 ran on 2026-10-31 in a dev window, against a demo repo with a script writing to it and a daemon with its
own `HOME`. Each kind of file was discarded from the row's menu and its copy found in `~/.Trash`; a deleted file had
no copy, as expected. `qa*` left the other `qa-` files alone. The symlink and the folder were refused with the reason
in the dialog. A file written while the dialog was open was refused, kept its text and sent nothing to the Trash. The
diff header moved on to the next file and closed after the last. A commit from ticks left an agent's staged file
staged and out of it, and a hook's refusal showed its output and kept the ticks and message, with the new files back
to untracked, until a retry worked. It found one bug, now fixed: a refusal after the click took the Discard button
and the focus away, so Esc did nothing. The busy-agent warning was not seen in the app, as no agent ran in that
daemon; `agentRefusal` has unit tests.

Each write test must be seen to fail once: remove `--literal-pathspecs` and the fingerprint check, and watch the
tests go red.

## Later

- **Discard a hunk.** `git apply -R` on one hunk from the diff, under the same fingerprint. It needs a real patch
  built from `changes/diff.ts`, so it comes after whole-file discard has proved itself.
- **Discard an untracked folder.** Needs a check for nested repositories first: a live worktree under
  `.claude/worktrees/` shows up as one when it is not ignored.
- **Add to .gitignore**, and **Revert commit**, which adds a commit and rewrites nothing.

## Known limits

- The ticks and the message live in the panel, so they are lost when it closes or moves to another checkout.
- The moment between the fingerprint check and the restore is unguarded. It lasts milliseconds, but a write in
  that moment is lost: the copy in the Trash holds the file as it was checked.
- Only agents in a Herdr pane can trigger the warning.
- The `--only` commit takes the whole file, including anything an agent has written to it since you read it.
  Ticking is your claim on the file.
