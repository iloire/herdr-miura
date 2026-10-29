# Plan: a header over each tab with what its sessions cost

Token use is the thing to watch with several agents running, and loops most of all: a loop pays about its
whole context on every tick, whether or not the tick does anything. The status bar shows the plan's meter for
the whole account; nothing said which session was spending it.

## Where the data comes from

Claude Code writes every response's `usage` (input, output, cache reads, 5-minute and 1-hour cache writes)
into the session's transcript, `~/.claude/projects/<project>/<session>.jsonl`, and subagents into
`<session>/subagents/*.jsonl`. A Claude Code hook (dotfiles' `herdr-attention session`) reports the session's
id on its pane, which ties a transcript to a tab. Herdr cuts token values at 80 characters, so the id, not the
path.

Raw counts mislead: in one real session cache reads were 6.35M tokens against 50k of output. Spend is weighted
as fresh-input tokens (output ×5, cache writes ×1.25 / ×2, reads ×0.1) and counted from the start of the
plan's 5-hour window, the one the status bar's meter shows.

## Steps

1. ~~Hook: `herdr-attention session` on `SessionStart` and `UserPromptSubmit` reports `claude_session=<id>`
   once per session; `SessionEnd` clears it. Bats tests.~~ ✅
2. ~~`session_usage.rs`: find each session's transcript, read it on from the last poll, count each response
   once (its last copy), add subagents, bucket by minute. Rust tests, one proven able to fail.~~ ✅
3. ~~Header over the focused tab: per agent its status, model, context, spend this window, a 15-minute burn
   chart and the loop tag. Hidden for a tab without agents. Checked live against a jq recount.~~ ✅
4. Burn colors: the header turns amber, then red, past a burn rate you set, so a costly loop in a background tab
   is hard to miss. Thresholds in a file you edit, not in code.
5. Loops: cost per tick and projected per day on the loop line, and a warning when each tick rewrites the
   whole context to the cache because the gap outlived it.
6. The same figures, smaller, on tabs and workspace cards, with a breakdown by tab on hover.

## Not covered

- Sessions on another machine: their transcripts are there, as with the Changes panel.
- A session running before the hook existed shows its numbers from its next prompt.
