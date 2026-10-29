import { describe, expect, it } from "vitest";
import { agentIssues, parseAgentFile, promptPreview } from "../agentFile";

const member = { role: "qa", agent: "qa" };

describe("parseAgentFile", () => {
  it("reads flat fields, comma tools and the prompt", () => {
    const file = parseAgentFile(
      "---\nname: qa\ndescription: Checks changes\nmodel: opus\ntools: Read, Grep, Bash\n---\nYou check.\n\nThen report.\n",
    );
    expect(file).toEqual({
      name: "qa",
      description: "Checks changes",
      model: "opus",
      tools: ["Read", "Grep", "Bash"],
      skills: [],
      prompt: "You check.\n\nThen report.",
    });
  });

  it("reads YAML lists, flow lists, quotes and blocks, and skips nested maps", () => {
    const file = parseAgentFile(
      [
        "---",
        'name: "qa"',
        "description: >",
        "  Checks changes",
        "  in the app",
        "tools: [Read, 'Bash']",
        "skills:",
        "  - api-conventions",
        "- error-handling",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: Bash",
        "model: sonnet # cheap",
        "---",
        "Body",
      ].join("\r\n"),
    );
    expect(file).toMatchObject({
      name: "qa",
      description: "Checks changes in the app",
      tools: ["Read", "Bash"],
      skills: ["api-conventions", "error-handling"],
      model: "sonnet",
      prompt: "Body",
    });
  });

  it("says why frontmatter does not parse", () => {
    for (const [text, error] of [
      ["no frontmatter", "does not start"],
      ["---\nname: qa\n", "no closing"],
      ["---\nname qa\n---\n", "line 2 is not key: value"],
      ["---\nname: a\nname: b\n---\n", "name is given twice"],
      ["---\n  - x\n---\n", "indented under no key"],
      ["---\nskills:\n  - a\n  b: c\n---\n", "not a - item of skills"],
    ]) {
      expect(parseAgentFile(text)).toEqual({ error: expect.stringContaining(error) });
    }
  });
});

describe("agentIssues", () => {
  const read = (text: string) => agentIssues(member, { phase: "text", text });

  it("has none for a file Start will find", () => {
    expect(read("---\nname: qa\ndescription: Checks\n---\nYou check.")).toEqual([]);
  });

  it("warns that a missing file may still be a user or plugin agent", () => {
    expect(agentIssues(member, { phase: "missing" })).toEqual([
      expect.stringMatching(/^Start will fail unless qa is a user or plugin agent: \.claude\/agents\/qa\.md is not in this repo/),
    ]);
  });

  it("flags a name that is not the agent's, and missing name or description", () => {
    expect(read("---\nname: qa-browser\ndescription: Checks\n---\n")).toEqual([
      expect.stringContaining("name: qa-browser, but claude --agent qa"),
    ]);
    expect(read("---\nmodel: opus\n---\n")).toEqual([
      expect.stringContaining("no name"),
      expect.stringContaining("no description"),
    ]);
    expect(read("nothing")).toEqual([expect.stringContaining("skips .claude/agents/qa.md: it does not start")]);
    expect(agentIssues(member, { phase: "not_text" })).toEqual([expect.stringContaining("not a text file")]);
  });
});

describe("promptPreview", () => {
  it("joins hard-wrapped lines but keeps paragraphs and list items apart", () => {
    expect(promptPreview("\nYou review; read\nthe diff.\n\n  Then report:\n- bugs\n- tests\n")).toBe(
      "You review; read the diff.\nThen report:\n- bugs\n- tests",
    );
  });
});
