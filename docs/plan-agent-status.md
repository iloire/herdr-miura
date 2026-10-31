# Plan: agent status you can see at a glance

herdr-gpui shows each agent's state where you look anyway: a mark per workspace and tab, a count of agents
waiting on you, the agents themselves under their workspace, and a Dock badge. Today this app has a 7 px
colored dot and a colored rail, which is easy to miss and says nothing about how many agents are waiting.

## Where the data comes from

Only the daemon snapshot, as in herdr-gpui ("status comes from the daemon's snapshot, never from guessing at
terminal output"). `workspaces[].agent_status`, `tabs[].agent_status` and `agents[]` (pane, tab, workspace,
name, status) are already in `protocol.ts`. Nothing new crosses the bridge.

## The marks

The first set, still drawn this way. [architecture.md](architecture.md) (`app/attention.ts`) has what came after: a filled
check for work verified done, gold for a finished agent that needs you, and those agents in the Dock count.

Ported from herdr-gpui's default `outline` icons (Apache-2.0), drawn as inline SVG in `currentColor`:

| Status | Mark | Color |
| --- | --- | --- |
| working | an arc turning in a faint ring (`status-orbit`), still under reduced motion | `--working` |
| blocked | an amber disc holding the number of agents waiting on you | `--lantern` |
| done | a ring with a check | `--done` |
| idle | a small hollow ring, dimmed | `--muted` |
| unknown | nothing | |

## Steps

1. ~~`src/app/attention.ts`: pure functions over a snapshot. Per workspace: its agents sorted blocked, done,
   working, idle (herdr-gpui's `status_priority`), and how many are blocked. For the window: how many agents
   are blocked or done (the Dock count). Vitest tests, one proven able to fail.~~ ✅
2. ~~`StatusMark` component replacing `StatusDot` in the sidebar and tab bar.~~ ✅
3. ~~Sidebar: under each workspace, one row per agent with its mark and name (display name, else agent kind,
   else title). Clicking a row focuses that agent's pane (`pane.focus`, already allowed).~~ ✅
4. ~~Dock badge and window title: the count of blocked + done agents, as herdr-gpui counts it, through
   `setBadgeCount` (needs `core:window:allow-set-badge-count`), and `(2) ` before the title. Clears at zero.~~ ✅
5. ~~Check it in the real app; update the README and architecture doc.~~ ✅ Working and idle checked live;
   blocked and done rendered with the app's stylesheet. The Dock badge waits for a real finished or blocked agent.
6. ~~Agent rows say where the agent is (herdr-gpui's `agent_place`): the tab when the workspace has several or
   it was named, else the pane's name or title, since every row otherwise reads "claude".~~ ✅

## Later, not in this step

System notifications when an agent finishes or blocks while the window is in the background
(`tauri-plugin-notification`), sounds, alternative icon sets (dots, braille, wave), and sorting agents.
