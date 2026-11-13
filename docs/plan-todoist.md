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
- **Completing a task in Todoist when the work is done asks first**: a button on the Day dialog's row. So does adding a
  parked note as a subtask. Only a `you` writes by itself, as a comment.
- **A task is linked to the pane its agent runs in**, in `todoist.jsonl` beside the outcome ledger, since a ledger
  entry names its pane and the session is not known yet when the prompt goes. The link covers that pane's outcomes until
  the first that ends the work, and only from the session that reported first.
- Closing a task in Todoist also completes its open subtasks, so a parked note added as a subtask goes with it.

## Ideas

Everything that came up, by theme. Ideas 1 to 4 and 6 are built, bar the `/remind` merge in 4. The rest is written down so it isn't lost, not
decided.

### 1. The panel ✅

- Tasks the filter matches, dated first and then by priority, each with its due date (red when overdue),
  project, labels and priority mark. A search box narrows the list.
- Clicking a task picks its template, fills it with the task, and shows it ready to edit. From there the
  prompt goes to the focused agent, to a fresh Claude in a new tab, or into the workspace's queue (⌘1, ⌘2, ⌘3,
  ⌘↵ for the default), as the prompt library sends.

### 2. Repo routing ✅

- Map Todoist projects to repos in settings (`Herdr` → `~/code/herdr-miura`), so the panel shows the focused
  workspace's tasks, with a toggle for all of them.
- A `@repo:<name>` label overrides the mapping for one task.
- A task with no repo gets a "Send to…" menu of workspaces. (Not built: a task for another repo offers that repo's
  workspace; one with no repo goes to the focused one.)

### 3. Closing the loop ✅

Built as below, except that a `you` comments rather than adding a waiting label.

- Keep the task id with the agent or queue item a prompt started from a task.
- `herdr-outcome done`, verified, offers to complete the task, with a comment naming the commits and the
  agent's summary. Ask first, as decided above.
- `herdr-outcome left "<what>"` becomes a subtask or a new task in the same project, so the parked note
  reaches Todoist and not only the ledger.
- `herdr-outcome you "<what>"` comments on the task or adds a waiting label, so Todoist on the phone shows an
  agent blocked on you.
- The Day dialog counts the tasks closed today.

### 4. From the app to Todoist ✅

- ~~A parked ledger entry goes to Todoist with one button (plan-inbox's Later item).~~ ✅ **To Todoist** on a parked
  note in the Queue panel: a task titled with the note, its repo and branch in the description, in the workspace's
  project (else the Inbox). The entry is resolved as `todo`, so it leaves Parked.
- ~~A queued prompt can be turned into a dated Todoist task, to run later rather than wait in the queue.~~ ✅ ☐ on a
  waiting prompt (**Remind in Todoist**) opens a due date field, read by Todoist (`tomorrow 9am`, `next monday`, sent
  as `due_string`). The task holds the prompt whole in its description, and the prompt leaves the queue only once
  Todoist has the task. Opening the task later as a prompt puts it back.
- `/remind` could write a Todoist task as well as, or instead of, the reminders inbox. Not built: it merges two
  reminder systems, so it is its own decision. What it would take:
  - `/remind` is a skill that appends a row to `~/notes/Areas/systems/automation/reminders-inbox.md`, and the
    life-assistant loop in the notes vault delivers it. A Todoist version needs the token outside the app: the skill
    would call `POST /api/v1/tasks` itself (with `curl`, the token read from the keychain item `todoist`), since an
    agent can't reach the app's Rust side.
  - Choose one home per reminder: Todoist alone (the loop stops delivering, or reads Todoist), or both (the loop
    skips rows marked as sent to Todoist). Two systems that both fire would remind twice.
  - Due dates: the inbox keeps an absolute date computed with `date`; Todoist reads natural language, so the skill
    could pass the user's own words as `due_string`.
  - Reminders made away from a repo (from the vault, or the phone) already work in Todoist, which is the case for
    moving there.

### 5. Automation, with care

- Tasks labelled `@agent` are pulled into the queue as waiting prompts, but nothing starts on its own.
- Several tasks selected at once become one queue prompt or several, so related tasks run as one batch.
- A cheap agent triages the inbox, suggesting a repo and a template for each task, to accept or refuse.

### 6. Small things ✅

- A status bar chip, `☐ 4 today`, beside the parked count: the filter's tasks due today or before. It opens the panel,
  hides without a token, and stays off the Dock badge.
- A quick-add box in the panel that creates a task in the workspace's project (the one `todoist.projects` maps to its
  folder), else the Inbox. It says where the task went, with a link.
- A sent prompt links back to its task: the tab header shows `☐ <task>` for a tab whose pane a task's prompt went to,
  and a queue item from a task names it, with ↗ among its tools.
- A task's comments, shown in the opened task above the prompt, as that is often where the real spec is. **Add to
  prompt** appends them, and `{{task.comments}}` puts them in a template.

## Steps

1. ~~`todoist.rs`: the token from the keychain or the environment, tasks by filter with project names, tests.~~ ✅
2. ~~`app/todoist.ts`: filling a template, choosing one, sorting and searching, tests.~~ ✅
3. ~~The Todoist panel in the drawer, its switch button, the `todoist_tasks` command, `todoist.filter` in
   Settings.~~ ✅
4. ~~Repo routing (idea 2).~~ ✅
5. ~~Task ids kept with prompts, and `done` / `left` written back to Todoist (idea 3).~~ ✅
6. ~~The small things: status bar chip, quick add, comments, link back (idea 6).~~ ✅
7. ~~From the app to Todoist: parked notes and dated reminders from the Queue panel (idea 4).~~ ✅
