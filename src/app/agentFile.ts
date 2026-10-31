// A role's Claude Code agent file, `.claude/agents/<agent>.md`: YAML
// frontmatter (read by `frontmatter.ts`), then the prompt.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { readFile } from "../files/listing";
import { field, list, parseFrontmatter } from "./frontmatter";
import type { Member } from "./team";

export interface AgentFile {
  name: string | null;
  description: string | null;
  model: string | null;
  tools: string[];
  skills: string[];
  /// The body after the frontmatter: the agent's system prompt.
  prompt: string;
}

/// What reading a role's agent file found, before it is parsed.
export type AgentRead = { phase: "missing" } | { phase: "not_text" } | { phase: "text"; text: string };

export function agentPath(agent: string): string {
  return `.claude/agents/${agent}.md`;
}

/// The file's fields and prompt, or why its frontmatter does not parse.
export function parseAgentFile(text: string): AgentFile | { error: string } {
  const parsed = parseFrontmatter(text);
  if ("error" in parsed) return parsed;
  if (!parsed.present) return { error: "it does not start with a --- frontmatter line" };
  const { fields } = parsed;
  return {
    name: field(fields, "name"),
    description: field(fields, "description"),
    model: field(fields, "model"),
    tools: list(fields.get("tools") ?? null),
    skills: list(fields.get("skills") ?? null),
    prompt: parsed.body,
  };
}

/// What is wrong with a role's agent file, each as one sentence; none when
/// Start should find it. Never a reason not to show the role.
export function agentIssues(member: Member, read: AgentRead): string[] {
  const path = agentPath(member.agent);
  if (read.phase === "missing") {
    return [`Start will fail unless ${member.agent} is a user or plugin agent: ${path} is not in this repo`];
  }
  if (read.phase === "not_text") return [`${path} is not a text file`];
  const file = parseAgentFile(read.text);
  if ("error" in file) return [`Claude Code skips ${path}: ${file.error}`];
  const issues: string[] = [];
  if (!file.name) issues.push(`Claude Code skips ${path}: it has no name`);
  else if (file.name !== member.agent) {
    issues.push(`${path} says name: ${file.name}, but claude --agent ${member.agent} looks agents up by name`);
  }
  if (!file.description) issues.push(`Claude Code skips ${path}: it has no description`);
  return issues;
}

/// What each built-in Claude Code tool does, finishing "Tool this agent may use: …".
const TOOL_WORK = new Map([
  ["Read", "reads files"],
  ["Write", "creates files or overwrites them"],
  ["Edit", "changes text in existing files"],
  ["Grep", "searches inside files"],
  ["Glob", "finds files by name pattern"],
  ["Bash", "runs shell commands"],
  ["Agent", "starts subagents"],
  ["WebFetch", "fetches a web page"],
  ["WebSearch", "searches the web"],
  ["NotebookEdit", "edits Jupyter notebook cells"],
]);

/// The tooltip of a `tools:` entry: `Read`, a scoped `Bash(git:*)`, an MCP
/// `mcp__server__name`, or a name it does not know.
export function toolTooltip(tool: string): string {
  const open = tool.indexOf("(");
  const name = open < 0 ? tool : tool.slice(0, open);
  const scope = open < 0 ? "" : tool.slice(open + 1).replace(/\)$/, "");
  const server = /^mcp__(.+?)(?:__|$)/.exec(name)?.[1];
  const work = TOOL_WORK.get(name) ?? (server && `comes from the MCP server ${server}`);
  return `Tool this agent may use${work ? `: ${work}` : ""}${scope ? `, limited to ${scope}` : ""}`;
}

/// The start of a prompt as flowing text: the file's hard-wrapped lines
/// joined, keeping its paragraphs, list items and headings on lines of their
/// own. The dialog clamps it to a few lines.
export function promptPreview(prompt: string): string {
  return prompt
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .reduce((text, line) => (!text ? line : /^([-*+]|\d+\.|#)\s/.test(line) ? `${text}\n${line}` : `${text} ${line}`), ""),
    )
    .join("\n")
    .slice(0, 600);
}

async function readAgent(directory: string, agent: string): Promise<AgentRead> {
  try {
    const contents = await readFile(directory, agentPath(agent));
    return contents.type === "text" ? { phase: "text", text: contents.text } : { phase: "not_text" };
  } catch {
    // `read_file` cannot tell a missing file from an unreadable one; either way Start will not find it.
    return { phase: "missing" };
  }
}

/// Each agent's file in the folder `directory`, by agent name: read when the
/// list changes and again when the window comes back, since they are edited
/// in another app. `version` rereads them at once, after one is created.
export function useAgentFiles(directory: string, agents: readonly string[], version: number): Map<string, AgentRead> {
  const [files, setFiles] = useState<Map<string, AgentRead>>(new Map());
  const key = agents.join("\0");
  useEffect(() => {
    const list = key ? [...new Set(key.split("\0"))] : [];
    let live = true;
    const refresh = () => {
      Promise.all(list.map((agent) => readAgent(directory, agent))).then((reads) => {
        if (live) setFiles(new Map(list.map((agent, i) => [agent, reads[i]])));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [directory, key, version]);
  return files;
}

/// Opens one file of the folder `root` in VS Code.
export function openFile(root: string, path: string): Promise<void> {
  return invoke("open_file", { root, path });
}

/// Writes an agent's file from its starter, or a stub; resolves with its path.
export function createAgent(directory: string, agent: string): Promise<string> {
  return invoke("create_agent", { directory, agent });
}
