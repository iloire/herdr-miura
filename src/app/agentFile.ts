// A role's Claude Code agent file, `.claude/agents/<agent>.md`: YAML
// frontmatter, then the prompt. The parser is a small one for the shapes
// these files use (flat `key: value`, `[a, b]` and `- item` lists, `|`/`>`
// blocks) and leaves nested maps such as `hooks` unread.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { readFile } from "../files/listing";
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

type Value = string | string[] | null;

const KEY = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/;

export function agentPath(agent: string): string {
  return `.claude/agents/${agent}.md`;
}

/// A scalar without its quotes and trailing comment.
function scalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted) return quoted[2];
  return text.replace(/\s+#.*$/, "");
}

/// `a, b` or `[a, b]` as a list; a YAML list stays one.
function list(value: Value): string[] {
  if (value === null) return [];
  const items = Array.isArray(value) ? value : value.replace(/^\[(.*)\]$/, "$1").split(",");
  return items.map(scalar).filter(Boolean);
}

/// The file's fields and prompt, or why its frontmatter does not parse.
export function parseAgentFile(text: string): AgentFile | { error: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { error: "it does not start with a --- frontmatter line" };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { error: "its frontmatter has no closing ---" };
  const fields = new Map<string, Value>();
  let key: string | null = null;
  // An indented line belongs to `key`: a `- item`, a block's text, or a nested map left unread.
  let block: "list" | "text" | "nested" | null = null;
  const blockText: string[] = [];
  const finish = () => {
    if (key && block === "text") fields.set(key, blockText.join(" ").trim());
    blockText.length = 0;
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line) || line.startsWith("- ")) {
      if (!key) return { error: `line ${i + 1} is indented under no key` };
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (block === null) block = item ? "list" : "nested";
      if (block === "list") {
        if (!item) return { error: `line ${i + 1} is not a - item of ${key}` };
        (fields.get(key) as string[]).push(scalar(item[1]));
      } else if (block === "text") {
        blockText.push(line.trim());
      }
      continue;
    }
    finish();
    const match = KEY.exec(line);
    if (!match) return { error: `line ${i + 1} is not key: value` };
    key = match[1];
    if (fields.has(key)) return { error: `${key} is given twice` };
    const value = match[2]?.trim() ?? "";
    block = null;
    if (value === "") fields.set(key, []);
    else if (/^[|>][+-]?$/.test(value)) {
      block = "text";
      fields.set(key, "");
    } else fields.set(key, scalar(value));
  }
  finish();
  const field = (name: string) => {
    const value = fields.get(name);
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    name: field("name"),
    description: field("description"),
    model: field("model"),
    tools: list(fields.get("tools") ?? null),
    skills: list(fields.get("skills") ?? null),
    prompt: lines.slice(end + 1).join("\n").trim(),
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
