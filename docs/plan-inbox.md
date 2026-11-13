# Plan: an outcome ledger, so nothing an agent leaves gets lost

With several agents running at once, it is hard to keep up with what happened, what is left and what waits on you.
Agents already say how a task ended (`herdr-outcome done | left | you | not-started`), but that answer is a token on
the pane: the next prompt or the end of the session clears it, and a closed tab takes it along. A `left "<what>"`
is gone as soon as anyone types in that session again.

The fix is to write every outcome down, then show what was written in the views that already answer each question,
rather than in a new panel.

## The ledger

`herdr-outcome` appends one JSON line per outcome to
`${HERDR_OUTCOME_LEDGER:-${XDG_STATE_HOME:-~/.local/state}/herdr/outcomes.jsonl}`, outside the app's data folder, so
Stable, Edge and a dev build read the same one.

```json
{"v":1,"id":"1762941600000-4f2a","at":"2026-11-12T10:00:00Z","kind":"left","note":"test the filter on GTK",
 "cwd":"/Users/ivan/code/herdr-miura/.claude/worktrees/x","home":"/Users/ivan/code/herdr-miura","branch":"x",
 "head":"9194381…","session":"<uuid>","workspace":"w3A","pane":"w3A:p1"}
```

- `kind`: `verified`, `unverified`, `left`, `you` or `not-started`; `note` holds the text, or why `done` was not
  verified.
- `home` is the main checkout, worked out as `queue::home` does, so a `left` from a worktree lands in its main
  checkout's queue even after the worktree is gone.
- The window appends what it does with an entry: `{"v":1,"resolves":"<id>","how":"queued|dismissed|todo|cleared","at":…}`.
  Append-only, one small line per write, so the script and several windows can share the file without locks.
- An entry is **open** while nothing resolves it. A `you` is also closed by any later entry from the same session.
- An open entry stops being listed once it is old: a `left` after 7 days, a `you` or `not-started` after 2
  (`STALE_DAYS`). Four days of real outcomes held 44 parked notes and 22 asks from closed sessions, most of them
  remarks or long since dealt with. The Day dialog still shows them behind "Show N older".

## Where it shows

| Question | Where | What |
| --- | --- | --- |
| What needs me now? | Agents section (exists) | A row per open `you` whose session no longer has a tab, with Clear. Clear Needs You on a tab also resolves its entry. |
| What is left in this repo? | Queue panel | **Parked**: the open `left` entries for the queue's folder. Queue it (becomes a waiting prompt), Copy, Dismiss. |
| What is left anywhere? | Status bar | `◌ 7 parked`, opening the Day dialog. |
| What happened today? | **Day** dialog | Every entry from today across repos, grouped by repo, newest first, plus anything still open from earlier days. |

The Dock badge does not count parked items: they are for later, and counting them would teach you to ignore it.

## Steps

1. ~~`herdr-outcome` appends to the ledger, with bats tests (dotfiles, branch `outcome-ledger`).~~ ✅
2. ~~`ledger.rs`: `ledger_read()` and `ledger_resolve(id, how)`, with tests.~~ ✅
3. ~~`app/ledger.ts`: pure folding of entries into open / resolved, by folder and by day, with tests; `useLedger` polls
   while the window is in front.~~ ✅
4. ~~Parked in the Queue panel; Queue it hands the note to `actions.add` as a prompt that stands on its own.~~ ✅
5. ~~The Day dialog and its status bar chip.~~ ✅
6. ~~Closed-session `you` rows in the Agents section; Clear Needs You resolves the entry.~~ ✅
7. Check it in a dev window, then README and architecture.

## Later

- ~~**To-do**: send a parked entry to Doable or Todoist. Settled: Todoist, **To Todoist** on a parked note ([plan-todoist.md](plan-todoist.md), idea 4).~~ ✅ Pulling `@agent` tasks into Parked is idea 5 there, not built.
- A daily summary of the ledger in the notes vault's daily note, from the life-assistant loop.
