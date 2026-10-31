# Plan: a prompt queue per workspace

You write the next prompt while an agent is still working, and today the only safe place to keep it is
another terminal, because a second agent on the same checkout would work over the first one's changes.
A queue lets you hand prompts to the workspace now. The window starts each one in a fresh Claude session
when the one before it has finished, one at a time, on the workspace's own checkout. Every prompt gets a new
context, and no two queued agents ever run at once.

## Where we start from

- **Herdr 0.9.5 can start an agent and prompt it.** `agent.start` (name, `kind: "claude"`, pane, timeout)
  starts a supported agent in a pane that sits at its shell prompt and returns once it is ready for input.
  `agent.prompt` (target, text, optional wait) submits a prompt. It refuses an agent that is `blocked`,
  and it reports `agent_prompt_stalled` when the agent does not start working within 5 s. Both are also
  CLI commands: `herdr agent start`, `herdr agent prompt`.
- **`tab.create` over the socket answers late**, as an event, and it cannot run anything in the new tab.
  `tab_move.rs` and the `feat/agent-team` worktree's `team.rs` both run the `herdr` CLI for this reason:
  `herdr tab create --cwd … --label … --no-focus` returns the new tab's pane straight away.
- **The snapshot already says when an agent is done.** `agents[]` carries each pane's `agent_status`,
  and `attention.ts` reads the loop tag (`attn_loop`) of a session `/loop` will run again.
  `changes/counts.ts` polls each workspace's changed-file count every 10 s.
- **Herdr has no queue.** So the queue is the window's own: like pins and workspace order, but kept in a
  file, because a queued prompt is work you wrote and must not lose.

## Decisions

- **One queue per workspace, keyed by the workspace's folder** (`new_workspace_cwd`, else the folder most of its tabs are in, never the focused tab's alone) and host. Workspace
  ids change when the daemon restarts, while the folder does not.
- **Sequential means no other agent at work in the workspace.** The next item starts only when no agent
  in the workspace is `working` or `blocked` and none carries a loop tag. Agents you started by hand count
  too, which is the point: the queue never runs beside them.
- **Each item gets a new tab and a new Claude.** `herdr tab create --workspace <id> --cwd <folder> --label
  "<title>" --no-focus`, then `herdr agent start q2 --kind claude --pane <pane>`, then
  `herdr agent prompt q2 <text> --wait --until working`. The tab stays open when the item ends: it holds
  the transcript you will want to read. The status rules that already exist mark it `done` until you
  look at it.
- **An item is finished** when its agent's status has been `done` or `idle`, with no loop tag, for 5 s
  in a row. The 5 s debounce absorbs brief idle moments between tool calls.
- **Clean tree between items (on by default).** Once an item finishes, the queue waits for the next
  changed-file count. If the checkout has uncommitted files, the queue pauses instead of starting the next
  item, and says why ("#2 left 3 uncommitted files"). You commit or discard them, then resume.
- **A suffix on every prompt**, by default `When you are done, commit your work: stage only the files you
  changed.` The queued agent then leaves a clean tree, and the next one starts from its commit.
- **Pause, don't guess.** A failed start, a stalled prompt, a closed tab or a dirty tree each pause the
  queue with the reason shown. Nothing is retried on its own.
- **The window drives it.** The queue only moves while the app is open and attached. This Mac only for
  now, like ports and worktrees: the CLI runs here.
- **Rust owns the file, TypeScript owns the decisions.** The dispatcher is a pure function of (queue,
  snapshot, counts) → next action, tested with Vitest. Rust stores the queue and runs the three CLI
  steps.

## The queue file

`queue-tauri.json` in the app's data directory (`~/Library/Application Support/<bundle id>/`). It is
state, not settings, so it does not go in dotfiles. It is written whole, atomically (temp file + rename).

```json
{
  "version": 1,
  "queues": {
    "local:/Users/you/code/herdr-tauri": {
      "paused": null,
      "items": [
        { "id": "q7", "n": 2, "prompt": "…", "state": "running", "pane_id": "p_31", "tab_id": "t_12",
          "added": "2026-10-29T10:02:00Z", "started": "2026-10-29T10:14:00Z", "head_at_start": "9a6c406" },
        { "id": "q8", "n": 3, "prompt": "…", "state": "queued", "added": "2026-10-29T10:05:00Z" }
      ],
      "history": [
        { "id": "q6", "n": 1, "title": "Tokenize styles.css colors", "state": "done",
          "started": "…", "finished": "…", "commits": 1 }
      ]
    }
  }
}
```

Item states: `queued` → `starting` (tab made, agent starting) → `running` → `done` (into `history`, the
last 20 kept), or `failed` / `stopped` (also into history, with `reason`). `paused` is `null` or
`{ "reason": "…" }`. `n` numbers items within a queue, so a tab and its card say the same "#2".

## The UI

### Workspace card

A chip on the card's mark line, after the status marks. It shows how many items are waiting. It turns
amber while the queue is paused, and a dot pulses beside it while an item runs.

```
┌──────────────────────────────────────────┐
│ herdr-tauri                    ◐ 1  ⧗ 3  │   ⧗ 3: three waiting, one running (◐)
│ main ↑12  ⑂1                             │
│   ◐ claude  · ⧗ #2 Persist font size     │
│   ✓ claude  · ⧗ #1 Tokenize styles.css   │
└──────────────────────────────────────────┘
```

- Hover lists the next three titles. Clicking the chip opens the Queue dialog.
- The agent rows under the card name the queue item ("⧗ #2 Persist font size") instead of the tab
  label, so you can see which prompt each one is working on.

### Tab bar and tab header

- A queued item's tab is labelled with its title alone, `Persist font size`, and shows the usual status
  mark. Herdr keeps the label, and nothing new is drawn in the tab bar.
- `TabHeader` gains one field for a queue tab: `queue #2 of 4 · next: Add pin sort`, the remaining
  items at a glance.

### Status bar

On the focused workspace's (right) half: `⧗ 3 queued`, or `⧗ paused` in amber. Clicking it opens the
dialog.

### The Queue dialog

It opens with ⌘⇧A ("Add to Queue"), from the command palette, or from the card's chip. It is drawn like
`WorktreesDialog`: 760 px wide, in the workspace's hue, closed with Esc.

```
┌─ QUEUE ─────────────────────────────────────────────────────────── × ┐
│ herdr-tauri                                                          │
│ 1 running · 3 waiting · runs one at a time        [ ❚❚ Pause ]       │
├──────────────────────────────────────────────────────────────────────┤
│ ▌ Paused: #2 left 3 uncommitted files.  [Open Changes] [Resume]      │  (only when paused)
├──────────────────────────────────────────────────────────────────────┤
│ NOW                                                                  │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ◐ #2  Persist font size                         working · 6m     │ │
│ │ Make ⌘+/⌘-/⌘0 write terminal.font_size so the size survives …    │ │
│ │ [→ Go to tab]  [Stop after this]                                 │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ UP NEXT                                                              │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ⠿ #3  Add pin sort                                  ✎  ↑  ↓  ×   │ │
│ │ Sort pinned tabs by …                                            │ │
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ ⠿ #4  Theme picker preview                          ✎  ↑  ↓  ×   │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ DONE                                                                 │
│   ✓ #1  Tokenize styles.css colors          1 commit · 14m · 10:16   │
│   ✕ #0  Try the SSH health probe       stalled: agent never started  │
├──────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ Write a prompt… (first line is its title)                        │ │
│ │                                                                  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ☑ commit when done    ☑ wait for a clean tree        [ Add  ⌘↵ ]     │
└──────────────────────────────────────────────────────────────────────┘
```

- **Composer first.** The dialog opens with focus in the prompt box: ⌘⇧A, paste, ⌘↵, Esc. ⌘↵ adds the
  prompt to the end of the queue and clears the box. If nothing is running, the item starts at once.
  ⇧⌘↵ puts it at the front instead.
- **Title** is the prompt's first line, cut at 60 characters. The card shows two more lines of the
  prompt, and clicking the card shows the whole text.
- **Reorder** with ↑ ↓ or by dragging the ⠿ handle. Dragging uses pointer events, as `workspaceOrder.ts`
  does, since Tauri's file drop swallows HTML drag and drop. **Edit** (✎) swaps the card for a textarea,
  ⌘↵ saves it. **Remove** (×) asks for no confirmation; a toast offers Undo for 5 s.
- **Now** shows the running item with its live status mark and elapsed time. "Go to tab" focuses it,
  and "Stop after this" pauses the queue once the item finishes. Nothing kills a running agent: you
  close its tab yourself, and the item then becomes `stopped` and the queue pauses.
- **Done** lists the last items with their outcome. The commit count is `head_at_start..HEAD` once the
  item finishes. Hovering a failure shows the CLI's own error.
- The two checkboxes set the queue's defaults (the suffix and the clean-tree guard). They become the
  settings below once `config-tauri.toml` exists.

### Notifications

None in the first version. The card's chip and the existing `done` badge already show it. A system
notification when a queue empties or pauses belongs with the `notifications` setting in
[plan-settings.md](plan-settings.md).

## Settings

These wait for [plan-settings.md](plan-settings.md). Until then they are constants in `app/queue.ts`:

| Key | Default | What it does |
| --- | --- | --- |
| `queue.agent` | `"claude"` | The `--kind` given to `herdr agent start`. |
| `queue.agent_args` | `[]` | Extra arguments for it, e.g. `["--permission-mode", "acceptEdits"]`. |
| `queue.prompt_suffix` | the commit sentence above | Appended to every prompt; `""` for none. |
| `queue.require_clean_tree` | `true` | Pause instead of starting on a dirty checkout. |
| `queue.finish_debounce_s` | `5` | How long `done`/`idle` must hold before the item counts as finished. |

## Steps

0. ~~Spike the CLI path by hand.~~ ✅ `tab create` → `agent start` → `agent prompt` works; a multi-line
   prompt arrives as one paste. Found: a folder Claude has not trusted yet stops `agent start` with
   `agent_not_ready` (hence the `waiting` state), and the CLI takes `--` only with nothing after the
   text, so the text goes before `--wait`.
1. ~~Share the CLI helpers.~~ ✅ `queue.rs` uses `tab_move.rs`'s `herdr` / `run` / `checked`, as `team.rs` does.
2. ~~Rust `queue.rs`.~~ ✅ `queue_open` and `queue_prompt` are two commands, so an agent that is not ready
   can be prompted later. Tests for the round trip, the `.bak`, the shape check and every refusal.
3. ~~TS `app/queue.ts`.~~ ✅ 18 Vitest cases; dropping the "agent at work" gate turns its test red.
4. ~~The dispatcher (`app/useQueue.ts`).~~ ✅
5. ~~UI.~~ ✅ Built first as a dialog, then moved into the right-hand drawer as a Queue panel beside Changes
   and Files, which opens on its own for a workspace with prompts queued. ⌘⇧A, a tab bar button, the
   right-click item, the card and status bar chip, the tab header field.
   Reordering is ↑ ↓ only; dragging is left out. Checked live on a scratch repo: two prompts ran one after
   the other, each committed once, and an untrusted folder held the first one in `waiting` until answered.
   The dialog itself is still to be tried by hand.
6. ~~Docs.~~ ✅ README, architecture. A screenshot of the dialog waits for that first hand check.

## Later, not in this step

- ~~**"Add this to the queue", said to an agent** (and the same thing from any terminal).~~ ✅
  - **An inbox, not the file.** The window holds the queue in memory and saves it whole, so nothing else
    may write `queue-tauri.json`. Others drop one JSON file each into `queue-inbox/` beside it,
    `<unix-ms>-<random>.json`, written as `.tmp` and renamed:
    `{ "version": 1, "workspace_id": "w4H" | null, "folder": "/abs" | null, "prompt": "…", "front": false,
    "source": "…" }`. Once a second the window lists them (`queue_inbox_list`), adds each to its
    workspace's queue as if typed in the panel, saves, and only then moves the file to
    `queue-inbox/taken/`, kept 30 days (`queue_inbox_settle`). Only the window that owns the queue's lock
    (`queue.lock`) drains it: two windows sharing the data folder once lost each other's prompts. A file that fails the checks, or whose workspace has not opened within 24 h,
    moves to `queue-inbox/rejected/` with a `.reason.txt`. Its card reads "Queued from an agent".
  - **`herdr-queue add [--front] [--workspace ID | --folder PATH]`** reads the prompt
    on stdin and writes that file. It names the workspace from `$HERDR_WORKSPACE_ID`, which every Herdr
    pane exports, else the git checkout of the current directory, so an agent never has to work one out.
  - **A `/queue` skill.** The queued run starts in a fresh session
    that knows nothing of this one, so the skill has the agent first rewrite "this" as a prompt that
    stands on its own (the goal, the files, what is decided, how to check it), one task per prompt,
    show it, and then pipe it into `herdr-queue add` through a quoted heredoc. The global CLAUDE.md
    points to it.
  - A failed save leaves the files in the inbox, so a later launch may add one twice: a duplicate rather
    than a lost prompt.
- **Other agents** (`codex`, `opencode`): the `kind` setting already allows them, but only Claude is
  tested.
- **Remote hosts**: run the CLI over the SSH connection the window already holds.
- **Close finished tabs** after you have seen them, behind a setting.

## Open questions

- ~~**Two workspaces on one folder.**~~ ✅ They share one queue, keyed by the folder, and its gate
  looks at the agents of every workspace on that folder.
- **Ask-first items.** A per-item "hold" flag that stops the queue before that item starts, for prompts
  you want to read over once more when their turn comes.
