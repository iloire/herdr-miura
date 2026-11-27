# Plan: Doable tasks as prompts

Doable ([`~/code/doable`](../../doable)) holds what you mean to do, and Herdr Miura is where agents do it. The Doable
panel lists your tasks in the right-hand drawer, and clicking one fills a prompt template with it, ready to send to an
agent.

This was built for Todoist first (2026-11-12 to 11-14) and moved to Doable on 2026-11-27, when Todoist was left for
Doable, a to-do app of my own with a sync server on Vercel and Turso. Herdr talks to that server's `/v1` REST API
(`~/code/doable/server/README.md`), as the Mac app, the iPhone web app and agents do.

## Decisions

- **The token stays in Rust.** `doable.rs` reads it and calls the server, and the webview only ever gets tasks.
- **The token comes from the login keychain**, generic password service `doable`, read with `/usr/bin/security` as
  `claude_usage.rs` reads Claude Code's sign-in. Failing that, `DOABLE_TOKEN` from the app's environment, which covers
  Linux and a dev window started from a shell. Not in the settings file: `config-tauri.toml` is a symlink into
  `~/dotfiles`, so a token there would be committed to GitHub.
  - Herdr gets its own token, so it can be revoked alone: in `~/code/doable/server`, with the production `TURSO_*`
    values in the environment, `npm run admin -- token create herdr write`.
  - Store it once per Mac: `security add-generic-password -U -s doable -a "$USER" -w` (it asks for the token). A
    secret can't be provisioned, so this stays a manual step on each Mac.
- **The server** is `https://doable-chi.vercel.app`, or `DOABLE_URL` from the environment (a local `next dev`).
- **Which tasks are listed** is one Doable view in `doable.view` (default `today`): `today`, `upcoming`, `inbox`, or
  `project:<name>`, `label:<name>`, `repo:<name>`. Doable has views, not a filter language, so Todoist filters such as
  `today | overdue` have no equivalent. Its Today already holds overdue tasks, bar soft dates more than 3 days late,
  which it calls stale.
- **A task's repo is its repo link** (`{type: "repo", ref: "owner/name"}`), which Doable already has for agents, in
  place of the `@repo:<name>` label. `doable.projects` still maps whole projects to folders.
- **Templates are the prompt library's own files** (`~/.claude/commands`, `.claude/commands`). A task fills
  `{{task.title}}`, `{{task.description}}` (its notes), `{{task.id}}`, `{{task.url}}`, `{{task.project}}`,
  `{{task.labels}}`, `{{task.due}}`, `{{task.repo}}`, or `{{task}}` for the whole task. A template with none of these
  gets the task in place of `$ARGUMENTS`, or below its text.
- **A task opens with** the library prompt named after one of its labels (`@plan` opens `/plan`), else the one named
  `doable`, else the task alone.
- **Priorities are turned round** in `doable.rs`: Doable's p1 is the most urgent (1), the panel's 4.
- **Writing back asks first**: a button on the Day dialog's row completes the task for a verified done, with a dated
  note naming the commits appended to its notes, or adds a parked note as a subtask. A `you` writes nothing (Todoist
  got a comment; Doable has no comments, and it was decided not to touch the notes for it).
- **A task is linked to the pane its agent runs in**, in `doable.jsonl` beside the outcome ledger, since a ledger
  entry names its pane and the session is not known yet when the prompt goes. The link covers that pane's outcomes
  until the first that ends the work, and only from the session that reported first.
- Completing a task also completes its open subtasks, so a parked note added as a subtask goes with it.

## What changed from Todoist

- **Comments are gone**: Doable has none. The opened task shows no comments, and `{{task.comments}}` is no more; the
  notes are the description.
- **No page per task**: Doable's web app has no task URL, so ↗ opens the web app, and the prompt names the task's id
  instead of a link.
- **Due dates in words** (Remind in Doable) go through the server's quick add parser, as `Remind <words>`, and the
  task is then given its real title and notes. Words that hold no date are refused and the stray task deleted.
- **Due labels** are counted from today (Today, Tomorrow, Monday, 4 Jan), not shown as typed, since Doable keeps the
  words as they were typed (`tomorrow`), which stop holding a day later.
- **No paging**: Doable answers a view whole.

## Ideas

All of these were built for Todoist and carried over, bar what Doable can't hold:

1. ~~The panel: the view's tasks, a search box, a click to open one as a prompt.~~ ✅
2. ~~Repo routing: `doable.projects`, repo links, Send to another workspace.~~ ✅
3. ~~Closing the loop: a verified done completes the task, a `left` adds a subtask, the Day dialog counts the tasks
   completed today.~~ ✅ (a `you` no longer writes)
4. ~~From the app to Doable: **To Doable** on a parked note, **Remind in Doable** on a waiting prompt.~~ ✅
   `/remind` writing to Doable is Doable's own plan (its phase 5, reminders migration), not Herdr's.
5. ~~Automation, with care: `@agent` tasks suggested above the queue, triage by Haiku setting a template label and a
   repo link once accepted.~~ ✅
6. ~~Small things: the status bar chip, quick add, the tab header's link back.~~ ✅ (comments dropped)

## Steps

1. ~~`doable.rs` on Doable's `/v1` API, with tests, checked against a local `next dev` of the server.~~ ✅
2. ~~The webview: views, repo links, local due dates, no comments; `doable.view` in Settings.~~ ✅
3. Mint Herdr's token and put it in the keychain on each Mac (manual, above).
