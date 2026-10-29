# A team of agents

A workspace can name a team: a handful of roles, each one a Claude Code session in a tab of its own,
running as a different agent with its own prompt, tools, and model. The sidebar lists the focused
workspace's team under the workspace list, with each role's state in words, and **Start** opens every
role that is not running yet.

You still route the work between them. Nothing here passes messages from one agent to another.

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
