// The YAML frontmatter of Claude Code's markdown files (agents in
// `.claude/agents/`, prompts in `.claude/commands/`). A small reader for the
// shapes these files use: flat `key: value`, `[a, b]` and `- item` lists,
// `|`/`>` blocks. Nested maps such as `hooks` are left unread.

export type Value = string | string[] | null;

/// A file's fields and the text after them. `present` is false for a file
/// that does not start with `---`, which is all body.
export interface Frontmatter {
  present: boolean;
  fields: Map<string, Value>;
  body: string;
}

const KEY = /^([A-Za-z][\w.-]*):(?:\s+(.*))?$/;

/// A scalar without its quotes and trailing comment.
export function scalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted) return quoted[2];
  return text.replace(/\s+#.*$/, "");
}

/// `a, b` or `[a, b]` as a list; a YAML list stays one.
export function list(value: Value): string[] {
  if (value === null) return [];
  const items = Array.isArray(value) ? value : value.replace(/^\[(.*)\]$/, "$1").split(",");
  return items.map(scalar).filter(Boolean);
}

/// A non-empty string field, or null.
export function field(fields: Map<string, Value>, name: string): string | null {
  const value = fields.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

/// The file's fields and body, or why its frontmatter does not parse.
export function parseFrontmatter(text: string): Frontmatter | { error: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fields = new Map<string, Value>();
  if (lines[0]?.trim() !== "---") return { present: false, fields, body: lines.join("\n").trim() };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { error: "its frontmatter has no closing ---" };
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
  return { present: true, fields, body: lines.slice(end + 1).join("\n").trim() };
}
