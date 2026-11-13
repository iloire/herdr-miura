# Plan: Todoist tasks as prompts

Todoist holds what you mean to do, and Herdr Miura is where agents do it. Today a task reaches an agent by
copying it out of Todoist and writing a prompt around it. The Todoist panel lists your tasks in the
right-hand drawer, and clicking one fills a prompt template with it, ready to send to an agent.

This also settles the "To-do" item under Later in [plan-inbox.md](plan-inbox.md), which waited on
choosing between Doable and Todoist: it is Todoist.

## Decisions

- **The token stays in Rust.** `todoist.rs` reads it and calls Todoist's API v1, and the webview only ever
  gets tasks.
- **The token comes from the login keychain**, generic password service `todoist`, read with
  `/usr/bin/security` as `claude_usage.rs` reads Claude Code's sign-in. Failing that, `TODOIST_TOKEN` from the
  app's environment, which covers Linux and a dev window started from a shell. Not in the settings file:
  `config-tauri.toml` is a symlink into `~/dotfiles`, so a token there would be committed to GitHub.
  - Store it once per Mac: `security add-generic-password -U -s todoist -a "$USER" -w` (it asks for the token).
    A secret can't be provisioned, so this stays a manual step on each Mac.
- **Which tasks are listed** is one Todoist filter in `todoist.filter` (default `today | overdue`), so that
  syntax decides, not code.
- **Templates are the prompt library's own files** (`~/.claude/commands`, `.claude/commands`), not a new kind
  of file. A task fills `{{task.title}}`, `{{task.description}}`, `{{task.url}}`, `{{task.project}}`,
  `{{task.labels}}`, `{{task.due}}`, or `{{task}}` for the whole task. A template with none of these gets the
  task in place of `$ARGUMENTS`, or below its text.
- **A task opens with** the library prompt named after one of its labels (`@plan` opens `/plan`), else the
  one named `todoist`, else the task alone.
- **Completing a task in Todoist when the work is done asks first**, for now (step 3 below).

## Ideas

Everything that came up, by theme. Step 1 is built. The rest is written down so it isn't lost, not
decided.

### 1. The panel ✅

- Tasks the filter matches, dated first and then by priority, each with its due date (red when overdue),
  project, labels and priority mark. A search box narrows the list.
- Clicking a task picks its template, fills it with the task, and shows it ready to edit. From there the
  prompt goes to the focused agent, to a fresh Claude in a new tab, or into the workspace's queue (⌘1, ⌘2, ⌘3,
  ⌘↵ for the default), as the prompt library sends.

### 2. Repo routing

- Map Todoist projects to repos in settings (`Herdr` → `~/code/herdr-miura`), so the panel shows the focused
  workspace's tasks, with a toggle for all of them.
- A `@repo:<name>` label overrides the mapping for one task.
- A task with no repo gets a "Send to…" menu of workspaces.

### 3. Closing the loop

- Keep the task id with the agent or queue item a prompt started from a task.
- `herdr-outcome done`, verified, offers to complete the task, with a comment naming the commits and the
  agent's summary. Ask first, as decided above.
- `herdr-outcome left "<what>"` becomes a subtask or a new task in the same project, so the parked note
  reaches Todoist and not only the ledger.
- `herdr-outcome you "<what>"` comments on the task or adds a waiting label, so Todoist on the phone shows an
  agent blocked on you.
- The Day dialog counts the tasks closed today.

### 4. From the app to Todoist

- A parked ledger entry goes to Todoist with one button (plan-inbox's Later item).
- A queued prompt can be turned into a dated Todoist task, to run later rather than wait in the queue.
- `/remind` could write a Todoist task as well as, or instead of, the reminders inbox. That merges two
  reminder systems, so it is its own decision.

### 5. Automation, with care

- Tasks labelled `@agent` are pulled into the queue as waiting prompts, but nothing starts on its own.
- Several tasks selected at once become one queue prompt or several, so related tasks run as one batch.
- A cheap agent triages the inbox, suggesting a repo and a template for each task, to accept or refuse.

### 6. Small things

- A status bar chip, `☐ 4 today`, beside the parked count.
- A quick-add box in the panel that creates a task in the workspace's project.
- A sent prompt links back to its task.
- A task's comments, shown in the opened task, as that is often where the real spec is.

## Steps

1. ~~`todoist.rs`: the token from the keychain or the environment, tasks by filter with project names, tests.~~ ✅
2. ~~`app/todoist.ts`: filling a template, choosing one, sorting and searching, tests.~~ ✅
3. ~~The Todoist panel in the drawer, its switch button, the `todoist_tasks` command, `todoist.filter` in
   Settings.~~ ✅
4. Repo routing (idea 2).
5. Task ids kept with prompts, and `done` / `left` written back to Todoist (idea 3).
