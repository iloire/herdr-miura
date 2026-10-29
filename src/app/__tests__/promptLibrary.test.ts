import { describe, expect, it } from "vitest";
import { blocked, buildLibrary, defaultAction, type RawFile, type RawFolder, searchPrompts } from "../promptLibrary";

const text = (path: string, body: string): RawFile => ({ path, text: body, problem: null });
const folder = (dir: string, files: RawFile[], truncated = false): RawFolder => ({ dir, files, truncated });
const can = { agent: true, folder: true, queue: true };

describe("buildLibrary", () => {
  it("reads frontmatter, keeps $ARGUMENTS, and takes a file without frontmatter as all prompt", () => {
    const { prompts } = buildLibrary({
      global: folder("/home/.claude/commands", [
        text("review.md", "---\ndescription: Review the diff\nargument-hint: <focus>\nherdr.run: new-tab\n---\nReview $ARGUMENTS.\n"),
        text("plain.md", "Just do it.\n"),
      ]),
      project: null,
    });
    expect(prompts.map((p) => [p.name, p.description, p.argumentHint, p.run, p.body, p.broken])).toEqual([
      ["plain", null, null, null, "Just do it.", null],
      ["review", "Review the diff", "<focus>", "new-tab", "Review $ARGUMENTS.", null],
    ]);
  });

  it("puts project prompts first and lets one hide the global prompt of its name", () => {
    const { prompts } = buildLibrary({
      global: folder("/g", [text("land.md", "Land globally"), text("ship.md", "Ship")]),
      project: folder("/repo/.claude/commands", [text("land.md", "Land here"), text("zz.md", "Last by name")]),
    });
    expect(prompts.map((p) => [p.scope, p.name, p.body, p.overrides])).toEqual([
      ["project", "land", "Land here", true],
      ["project", "zz", "Last by name", false],
      ["global", "ship", "Ship", false],
    ]);
  });

  it("names a subfolder as the group, not part of the name", () => {
    const { prompts } = buildLibrary({ global: folder("/g", [text("git/land.md", "Land")]), project: null });
    expect(prompts[0]).toMatchObject({ name: "land", group: "git", path: "git/land.md", key: "global:git/land.md" });
  });

  it("shows every file that cannot be used as broken, with the reason", () => {
    const { prompts } = buildLibrary({
      global: folder("/g", [
        text("a-open.md", "---\ndescription: never closed\nDo it"),
        text("b-run.md", "---\nherdr.run: elsewhere\n---\nDo it"),
        text("c-empty.md", "---\ndescription: nothing below\n---\n"),
        { path: "d-big.md", text: null, problem: "it is over 256 KiB" },
        text("e-good.md", "Fine"),
      ]),
      project: null,
    });
    expect(prompts.map((p) => [p.name, p.broken])).toEqual([
      ["a-open", "its frontmatter does not parse: its frontmatter has no closing ---"],
      ["b-run", "herdr.run is “elsewhere”, not one of here, new-tab, queue"],
      ["c-empty", "it has no prompt text"],
      ["d-big", "it is over 256 KiB"],
      ["e-good", null],
    ]);
  });

  it("keeps the first file of a name in one folder and marks the other as clashing", () => {
    const { prompts } = buildLibrary({
      global: folder("/g", [text("land.md", "top"), text("git/land.md", "nested")]),
      project: null,
    });
    expect(prompts.map((p) => [p.path, p.broken])).toEqual([
      ["git/land.md", null],
      ["land.md", "/land is already git/land.md in this folder"],
    ]);
  });

  it("says when a folder had more files than were read", () => {
    const { notes } = buildLibrary({ global: folder("/g", [text("a.md", "a")], true), project: null });
    expect(notes).toEqual(["Only the first 1 files of /g are read."]);
  });
});

describe("searchPrompts", () => {
  const { prompts } = buildLibrary({
    global: folder("/g", [text("deploy.md", "---\ndescription: Ship it\n---\nRun the review first"), text("review.md", "Review")]),
    project: folder("/p", [text("plan.md", "Write the plan, then review it")]),
  });

  it("matches every word in the name, description or text", () => {
    expect(searchPrompts(prompts, "ship review").map((p) => p.name)).toEqual(["deploy"]);
    expect(searchPrompts(prompts, "nothing")).toEqual([]);
  });

  it("ranks a name match first and otherwise keeps project before global", () => {
    expect(searchPrompts(prompts, "review").map((p) => p.name)).toEqual(["review", "plan", "deploy"]);
    expect(searchPrompts(prompts, "").map((p) => p.name)).toEqual(["plan", "deploy", "review"]);
  });
});

describe("actions", () => {
  const [prompt] = buildLibrary({ global: folder("/g", [text("a.md", "a")]), project: null }).prompts;

  it("defaults to the focused agent, a new tab without one, or the file's herdr.run", () => {
    expect(defaultAction(prompt, true)).toBe("here");
    expect(defaultAction(prompt, false)).toBe("new-tab");
    expect(defaultAction({ ...prompt, run: "queue" }, true)).toBe("queue");
  });

  it("says why an action cannot run", () => {
    expect(blocked(prompt, "here", can)).toBeNull();
    expect(blocked(prompt, "here", { ...can, agent: false })).toBe("The focused pane has no agent.");
    expect(blocked(prompt, "new-tab", { ...can, folder: false })).toBe("This workspace has no folder on this Mac.");
    expect(blocked(prompt, "queue", { ...can, queue: false })).toBe("Another window has the queue.");
    expect(blocked({ ...prompt, broken: "bad" }, "queue", can)).toBe("bad");
  });
});
