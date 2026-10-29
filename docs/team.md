# A team of agents

A workspace can name a team: a handful of roles, each one a Claude Code session in a tab of its own,
running as a different agent with its own prompt, tools, and model. The sidebar lists the focused
workspace's team under the workspace list, with each role's state in words, and **Start** opens every
role that is not running yet.

You still route the work between them. Nothing here passes messages from one agent to another.

Every workspace card with a team shows a violet team mark: the number of roles, or `2/3` once some of
them are running. Hover over it to see each role's state.

## The Team dialog

Click the Team section's header (**TEAM 3**) to see the team in full. There is one card per role: its
letter in the role's hue, the agent it runs when that isn't the role's name, its state, and what its agent
file says: the description, pills for the model, the tools and the skills, and the first three lines of
the prompt. The files are read when the dialog opens and again whenever the window comes back to the
front, so an edit made in VS Code shows up when you switch back.

The dialog is read-only. **Edit** opens the role's agent file in VS Code, and **Open team.json** opens the
team file. A role whose file isn't in the repo gets **Create from template** instead: it writes New Team's
starter of that name if there is one (lead, reviewer, qa), otherwise a stub with a `name` and a
`description`, and opens it. It never writes over a file that is there.

A card with a problem gets a red rail and says what is wrong. It never stops you starting the role:

| Shown | Why |
| --- | --- |
| Start will fail unless qa is a user or plugin agent: .claude/agents/qa.md is not in this repo | The dialog only looks in the repo. `~/.claude/agents/` and plugins can still provide the agent. |
| Claude Code skips .claude/agents/qa.md: … | The frontmatter doesn't parse, or it has no `name` or no `description`. Claude Code doesn't load such a file. |
| .claude/agents/qa.md says name: qa-browser, but claude --agent qa looks agents up by name | Claude Code doesn't require the file name to match, but `--agent` looks agents up by `name`, so Start would not find this one. |

The frontmatter is read by a small parser in `app/agentFile.ts`. It handles the forms these files use:
flat `key: value`, `tools` as `Read, Grep` or `[Read, Grep]`, YAML `- item` lists (as `skills` is
written), and `|`/`>` text blocks. Nested maps such as `hooks` are skipped.

## Making one

Right-click a workspace and pick **New Team**. It writes a starter team into the workspace's folder:
`.herdr/team.json` with a lead, a reviewer and a qa role, and a generic agent file for each of them in
`.claude/agents/`. An agent file the repo already has is kept, and a folder that already has a team file
is refused. Commit the files and edit them to suit the repo. The starters are in `src-tauri/templates/team/`.

## The team file

`.herdr/team.json` in the workspace's folder (the folder new tabs open in):

```json
{
  "members": [
    { "role": "lead" },
    { "role": "reviewer" },
    { "role": "qa", "agent": "qa-browser" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `role` | The tab's name. The sidebar finds the role's tab by this name, so renaming the tab detaches it. |
| `agent` | Optional. The Claude Code agent the tab runs, as `claude --agent <agent>`. Defaults to `role`. |

Names are letters, digits, `-` and `_`, up to 32 characters, and can't start with `-`. A team has 1 to 12
members, with no role listed twice. A file that breaks these rules shows its error where the list would be.
The file is read again whenever the window comes back to the front.

## The roles themselves

Each agent is an ordinary Claude Code agent file, `.claude/agents/<agent>.md`, in the same repo:

```markdown
---
name: reviewer
description: Reviews diffs before anything is pushed
model: opus
tools: Read, Grep, Glob, Bash
---
You review; you never write features. ...
```

This is where the roles differ: the prompt, the tools they can use, and the model. `claude agents` lists
the agents Claude Code can see from a folder.

## What Start does

For each role that has no tab yet, `team.rs` runs the `herdr` CLI, as `tab_move.rs` does:
`herdr tab create --workspace <id> --cwd <folder> --label <role> --no-focus`, and then
`herdr pane run <its pane> claude --agent <agent>`. Clicking a role that isn't running starts only that
role; clicking a running one focuses its tab.

## States

| Shown | Means |
| --- | --- |
| not started | No tab in the workspace has the role's name. |
| shell | The tab is there, with no agent in it (Claude exited, or hasn't started yet). |
| waiting on you / working / done / idle | The most urgent status among the tab's agents. |

The team only works for this Mac's daemon, like the other features that run the `herdr` CLI.
