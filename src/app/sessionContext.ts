import { invoke } from "@tauri-apps/api/core";

// What fills each Claude Code session's context, read from its transcript by
// `session_context`. The totals are measured and the split is an estimate.

/// One thing in the context, and what it is made of.
export interface ContextNode {
  name: string;
  tokens: number;
  /// How many times it went in.
  count: number;
  /// The file it comes from, when it has one to open.
  path: string | null;
  children: ContextNode[];
}

export interface SessionContext {
  /// Measured: what the next turn starts from.
  context: number;
  /// Measured: what the first turn started from.
  opening: number;
  startup: ContextNode[];
  conversation: ContextNode[];
}

/// Each session's context, by id; `null` for one with no breakdown to give.
export async function readSessionContext(sessions: string[]): Promise<Map<string, SessionContext | null>> {
  const found = await invoke<(SessionContext | null)[]>("session_context", { sessions });
  return new Map(sessions.map((id, i) => [id, found[i] ?? null]));
}

interface Part {
  label: string;
  /// How to make it smaller; none for what cannot be cut.
  cut?: string;
}

const PARTS: Record<string, Part> = {
  "claude-code": { label: "Claude Code itself" },
  session: { label: "Session details" },
  memory: {
    label: "Memory files",
    cut: "Loaded whole into every session. Move what is rarely needed to a doc or skill, and link to it.",
  },
  skills: {
    label: "Skill listing",
    cut: "Every skill's description is listed in every session. Disable plugins you don't use, and shorten long descriptions.",
  },
  mcp: {
    label: "MCP servers",
    cut: "Each server lists its tools in every session, used or not. Remove the ones you rarely need, or scope them to a project.",
  },
  agents: {
    label: "Agent types",
    cut: "Each agent's description is listed in every session. The built-in ones stay; yours are in .claude/agents.",
  },
  tools: { label: "Tool calls and results" },
  prompts: { label: "Your prompts" },
  replies: { label: "Claude's replies" },
  injected: { label: "Injected text" },
  unitemized: { label: "Not itemized" },
};

export function partLabel(key: string): string {
  return PARTS[key]?.label ?? key;
}

export function partCut(key: string): string | undefined {
  return PARTS[key]?.cut;
}

/// The parts one can do something about.
function cuttable(part: ContextNode): boolean {
  return partCut(part.name) !== undefined;
}

/// A session's context in the strip's three bands: what is fixed, what you can
/// cut from the startup load, and the conversation, which `/compact` or a fresh
/// session clears. They add up to the measured context.
export interface Bands {
  fixed: number;
  yours: number;
  conversation: number;
}

export function bands(session: SessionContext): Bands {
  const sum = (parts: ContextNode[]) => parts.reduce((total, part) => total + part.tokens, 0);
  const yours = sum(session.startup.filter(cuttable));
  const fixed = sum(session.startup.filter((part) => !cuttable(part)));
  return { fixed, yours, conversation: Math.max(0, session.context - fixed - yours) };
}

/// Something the startup load carries, over the sessions that carry it.
export interface SharedItem {
  /// Its part's key.
  part: string;
  name: string;
  path: string | null;
  /// How many sessions carry it.
  sessions: number;
  /// Its tokens over all of them: what cutting it would free.
  total: number;
  /// Its tokens in the session that carries the most of it.
  each: number;
  children: ContextNode[];
}

/// Everything that could be cut, by what cutting it would free across the open
/// sessions: a smaller file loaded by every session can matter more than a
/// large one loaded by few.
export function sharedItems(sessions: readonly SessionContext[]): SharedItem[] {
  const items = new Map<string, SharedItem>();
  for (const session of sessions) {
    for (const part of session.startup.filter(cuttable)) {
      for (const node of part.children) {
        const key = `${part.name}\n${node.name}`;
        const item = items.get(key);
        if (!item) {
          items.set(key, {
            part: part.name,
            name: node.name,
            path: node.path,
            sessions: 1,
            total: node.tokens,
            each: node.tokens,
            children: node.children,
          });
          continue;
        }
        item.sessions += 1;
        item.total += node.tokens;
        if (node.tokens > item.each) {
          item.each = node.tokens;
          item.children = node.children;
        }
      }
    }
  }
  return [...items.values()].sort((a, b) => b.total - a.total);
}

/// A path with the home folder as `~`, as one would type it.
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

/// `root` and `path` as `open_file` takes them: the file within its own folder.
export function fileInFolder(path: string): { root: string; name: string } {
  const at = path.lastIndexOf("/");
  return { root: path.slice(0, at) || "/", name: path.slice(at + 1) };
}
