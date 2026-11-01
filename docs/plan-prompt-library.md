# Plan: a prompt library

Some prompts get typed again and again: "review the diff before I land it", "write the plan for …", "run
the checks and fix what fails". Today they live in your head or in a note, and reach an agent by copy and
paste. A library keeps them as files. A keystroke opens a palette over the window, and from it a saved
prompt goes to the agent you are looking at, to a fresh Claude in a new tab, or into the workspace's queue.

## Where we start from

- **Claude Code already has a prompt library: its custom slash commands.** A markdown file in
  `~/.claude/commands/` (global) or `<repo>/.claude/commands/` (that project) runs as `/<name>` inside
  Claude. Frontmatter is optional (`description`, `argument-hint`, `allowed-tools`, `model`), and
  `$ARGUMENTS` in the body takes what follows the command. Subfolders organise files without changing
  the command's name.
- **The queue already starts a fresh Claude in a new tab.** `queue_open` runs `herdr tab create
  --no-focus`, then `herdr agent start <name> --kind claude`; `queue_prompt` runs `herdr agent prompt
  <name> <text> --wait --until working`. Agent names must be `q<digits>` today. `herdr agent prompt`
  also takes a pane id as its target (`w49:p1S`), so the same call can reach the agent in the focused
  pane, whatever it is named or if it has no name.
- **The queue is kept by main checkout** (`queueFolder` in `app/workspaceRoot.ts`), and `useQueue`'s `actions.add(folder, prompt,
  front)` adds to it as the panel does.
- **Reads stay inside a folder.** `files.rs`'s `inside(root, path)` resolves a path through symlinks and
  refuses one that leaves the root; `read_file` and `open_file` both go through it.
- **Frontmatter is already parsed** for the Team dialog: `app/agentFile.ts`'s `parseAgentFile` reads the
  flat YAML these files use and says why it does not parse.
- **The window has a command palette** (`components/Palette.tsx`, ⌘⇧P): a filtered list, arrow keys,
  Enter. The library palette is drawn the same way, with a preview beside the list.
- **Pins are kept by the window** (`app/pins.ts`, `localStorage`), but keyed by daemon boot, since tab
  ids change on restart. Per-project choices in the library must outlive a restart, so they are keyed by
  folder, as the queue is.

## Decisions

- **The files are the library.** No database, no format of our own, no sync. A prompt is a
  `.claude/commands/*.md` file, so the same file is `/name` inside Claude and an entry in Herdr's palette.
  Writing one is writing a file, in any editor; dotfiles and git already carry them between machines.
- **Two folders, project over global.** The palette reads `~/.claude/commands/` and the focused
  workspace's `<folder>/.claude/commands/`. A project prompt hides a global one of
  the same name, which the palette marks ("overrides global"). Subfolders are read too; as in Claude Code
  the name is the file's, and the subfolder is shown beside it. Two files with one name in the same scope:
  the first by path is used and the other is shown as broken, naming the one it clashes with.
- **Frontmatter is optional and Herdr's own keys are optional too.** A file without a leading `---` is
  all prompt. Herdr reads `description` and `argument-hint`, and one key of its own, `herdr.run: here |
  new-tab | queue`, the action Enter takes (default `here` when the focused pane has an agent, else
  `new-tab`). Claude Code ignores keys it does not know.
- **A file that does not parse is shown, never skipped.** Frontmatter that does not parse, a file that is
  not text or is over 256 KiB, a `herdr.run` that is not one of the three, or a clashing name: the entry is
  listed as broken with the reason, and its actions are off. Fixing the file and coming back to the window
  rereads it.
- **Reads are bounded.** Rust lists the two folders (at most 500 files each, three folders deep, `.md`
  only) and returns each file's text or why it could not be read. A project file is resolved through
  symlinks and refused when it leaves the workspace folder, as `read_file` does. Global files may be links
  into a dotfiles repo, so those are followed. Local machine only, like the queue: the files and the CLI are here.
- **TypeScript decides, in a pure module.** `app/promptLibrary.ts` turns the two raw listings into the
  palette's entries: parse frontmatter, apply the override, mark the broken ones, sort and filter. Vitest
  covers it. The frontmatter reader moves out of `agentFile.ts` into `app/frontmatter.ts`, shared by both.
- **The palette** opens with ⌘⇧L ("Prompt Library"), also from the command palette and the book button at the
  right end of the tab header. It searches name,
  description and body; project prompts sort before global ones. The right side shows the selected
  prompt's text in an editable box: what you send is what the box holds, so a one-off change need
  not touch the file, and Save (⌘S) writes it there, keeping the frontmatter. Unsaved text survives closing the
  palette (`app/promptDrafts.ts`). Three actions on every entry:
  - **Send here** (⌘1): to the agent in the focused pane, with `herdr agent prompt <pane> <text> --wait
    --until working --until blocked`. Off when that pane has no agent.
  - **New tab** (⌘2): `queue_open` + `queue_prompt` with an agent named `p<digits>` (the `p` keeps it
    apart from the queue's `q` names), in a tab labelled `/<name>`, not focused.
  - **Queue** (⌘3): `actions.add(folder, text, false)`, exactly as typed in the Queue panel.

  Enter runs the entry's default action; ⌘↵ does the same from the preview box.
- **New prompt** (⌘N, the button under the list, or Enter on a search that matches nothing, whose words
  become the name) swaps the preview for a form: name, this project or global, an optional description, the
  text. It writes one new file and never over an existing one, a name its own scope already has is refused
  before saving, and so is a global name a project prompt would hide; a project prompt may take a global
  name, as overriding is what that is for. When `~/.claude/commands` holds links, the new global file goes
  beside what they point at (a dotfiles repo) and is linked in too, so dotfiles carry it like
  the others. Saving does not commit it there.
- **`$ARGUMENTS` is left alone.** Herdr substitutes nothing in this slice. The preview shows the text
  as it is, so you replace `$ARGUMENTS` yourself before sending, or leave it for a prompt that is meant to
  run as a slash command.

## Steps

1. ~~Write this plan.~~ ✅
2. ~~**First slice: read both folders, the palette and its three actions.**~~ ✅ `prompts.rs`
   (`prompt_library(directory)`, `prompt_send(pane, text)`; `queue::open` / `queue::prompt` accept `p`
   names), `app/frontmatter.ts` shared with `agentFile.ts`, `app/promptLibrary.ts` with 10 Vitest cases
   (letting the global prompt through beside the project one turns the override test red), and
   `components/PromptPalette.tsx` behind ⌘⇧L. Checked with the frontend on the dev server and a stubbed
   bridge: project prompts list before global ones, a project `remind` hides the global one, an unclosed
   frontmatter shows as broken with its actions off, and the three actions send the edited text to
   `prompt_send`, `queue_open` + `queue_prompt` and the queue. Checked against Herdr: `herdr agent prompt
   <pane id>` reached a Claude named `p1` and it answered. Still to try by hand in the window itself: a
   new tab that opens on an untrusted folder fails with the reason and leaves its tab, and does not wait
   for the agent as a queued item does.
3. ~~**New prompt from the palette.**~~ ✅ `prompts::create` (`prompt_create`), `components/NewPrompt.tsx`,
   and `promptName`, `nameTaken` and `promptFile` in `app/promptLibrary.ts`.
4. **Pin and hide per project.** Kept by the window, keyed by workspace folder as the queue is
   (`local:<folder>`), in the app's data folder beside the queue rather than in the repo: what you pin is
   your view, not the project's. Pinned prompts sort first; hidden global ones drop out of the list, with a
   "show hidden" toggle to bring one back. **Copy to project** writes `<folder>/.claude/commands/<name>.md`
   from the global file, refusing when that file exists (never an overwrite), so it can then be edited
   for this repo.
5. **Variables Herdr fills in.** `{{branch}}`, `{{changed_files}}`, `{{selection}}` (the terminal
   selection) and `{{workspace}}`, replaced in the preview when an entry is selected, so you see what will
   be sent. Plain substitution: an unknown `{{name}}` stays as written, and nothing else is a template.
6. **Save as prompt…** on a queue item's right-click menu (and the done list's rows): asks for a name and
   writes the item's prompt to the project's `.claude/commands/`, never over an existing file.
7. **A Library panel** in the right-hand drawer beside Changes, Files and Queue: the same entries,
   with the file's path, Open in VS Code (`open_file`), and the pin and hide controls.
8. **Suggest prompts you send often.** Look through finished queue items and past transcripts
   (`~/.claude/projects/*/*.jsonl`, already read by `session_usage.rs`) for prompts sent more than a few
   times in similar words, and offer each as a new file. Only offered, never written on its own.

## Out of scope

A database, syncing, sharing, versioning, and a template language beyond simple substitution. Git and
dotfiles already version and carry the files; anything more would be a second library beside Claude's.

## Open questions

- **Chained prompts.** One entry that queues several prompts in a row (plan, then build, then review). A
  list of files in frontmatter, or one file with a separator? It overlaps with the queue's own order.
- **Committed or local project prompts.** `.claude/commands/` is shared with everyone on the repo. Should
  Herdr also read a gitignored `.claude/commands.local/` for prompts that are yours alone, and which one
  does Copy to project write?
- **Where the palette opens.** From anywhere, as now, with the focused workspace's project prompts; or
  only per workspace (from its card or the tab strip), so it is always clear whose prompts you see.
