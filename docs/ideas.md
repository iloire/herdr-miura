# Ideas

Things worth remembering that nobody has decided to build. An entry here is not a plan: when one is picked up, it gets its
own `docs/plan-*.md`.

## Workspace groups

*Added 2026-11-01. Step 1 built on the `workspace-groups` branch, 2026-11-09: see [settings.md](settings.md#workspace-groups).*

Create two or three named groups in the sidebar, put workspaces in them, and expand or collapse each group. Today the list
is flat: the only grouping is a worktree nesting under its main checkout, plus the sort by hand or by attention.

**The risk to design around:** a collapsed group can hide an agent that is waiting on you.

- A collapsed group's header shows the same status marks and counts as a card (`AgentTally`), and blocked rows stay visible
  under it, as collapsed cards do with `AttentionRows`.
- The focused workspace is never hidden. Landing in a collapsed group, for example with Alt+Up/Down, opens it.
- Attention sort ignores groups. That mode answers "what needs me", so the list goes flat there and the groups come back
  when sorting by hand.

**Implementation notes:**

- Call them "Groups", not "Folders": "folder" already means a directory in this app, including the Folder submenu.
- The daemon only knows a flat ordered list, so names and membership go in the settings file next to `workspace_colors`,
  keyed the same way (`"<folder>#<name>"`) to survive restarts and renames. Open or collapsed state stays in the window's
  storage, like `openCards`.
- A worktree goes where its main checkout goes and can't be assigned separately.
- Remote workspaces have no fixed root, so that key doesn't work for them. They stay ungrouped at first, the same limit
  colors have.

**Build it in two steps,** because dragging is the expensive part: `useRowDrag` only understands gaps between rows, so
headers and dropping into a group mean reworking it.

1. Create, rename and delete groups, a Move to Group submenu on the workspace card, and collapse with rolled-up status.
2. Dragging between groups, if it still feels missing after using step 1.
