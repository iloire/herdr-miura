import { describe, expect, it } from "vitest";
import { bands, type ContextNode, fileInFolder, type SessionContext, sharedItems, shortPath } from "../sessionContext";

function node(name: string, tokens: number, children: ContextNode[] = [], path: string | null = null): ContextNode {
  return { name, tokens, count: 1, path, children };
}

function session(memory: ContextNode[], conversation = 0): SessionContext {
  const load = memory.reduce((total, file) => total + file.tokens, 0);
  return {
    context: 20_000 + load + conversation,
    opening: 20_000 + load,
    startup: [node("claude-code", 20_000), node("memory", load, memory)],
    conversation: [node("tools", conversation)],
  };
}

describe("bands", () => {
  it("parts what can be cut from what cannot, and adds up to the context", () => {
    expect(bands(session([node("/a", 5000)], 3000))).toEqual({ fixed: 20_000, yours: 5000, conversation: 3000 });
  });

  it("leaves the conversation at nothing when rounding overshoots", () => {
    const shrunk = { ...session([node("/a", 5000)]), context: 24_999 };
    expect(bands(shrunk).conversation).toBe(0);
  });
});

describe("sharedItems", () => {
  it("ranks by what cutting would free across sessions, not by size in one", () => {
    const everywhere = node("/global", 3000);
    const items = sharedItems([
      session([everywhere, node("/notes", 8000)]),
      session([everywhere]),
      session([everywhere]),
      session([everywhere]),
    ]);
    expect(items.map((item) => [item.name, item.sessions, item.total])).toEqual([
      ["/global", 4, 12_000],
      ["/notes", 1, 8000],
    ]);
  });

  it("leaves out what cannot be cut", () => {
    const items = sharedItems([{ ...session([]), startup: [node("claude-code", 20_000, [node("Read", 900)])] }]);
    expect(items).toEqual([]);
  });

  it("shows the largest copy of a file that differs between sessions", () => {
    const small = node("/a", 100, [node("old", 100)]);
    const large = node("/a", 200, [node("new", 200)]);
    const [item] = sharedItems([session([small]), session([large])]);
    expect(item.each).toBe(200);
    expect(item.children[0].name).toBe("new");
  });
});

describe("paths", () => {
  it("shortens the home folder", () => {
    expect(shortPath("/Users/me/.claude/CLAUDE.md")).toBe("~/.claude/CLAUDE.md");
    expect(shortPath("/opt/CLAUDE.md")).toBe("/opt/CLAUDE.md");
  });

  it("splits a file from its folder", () => {
    expect(fileInFolder("/Users/me/CLAUDE.md")).toEqual({ root: "/Users/me", name: "CLAUDE.md" });
    expect(fileInFolder("/x")).toEqual({ root: "/", name: "x" });
  });
});
