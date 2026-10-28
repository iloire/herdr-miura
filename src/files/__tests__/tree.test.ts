import { describe, expect, it } from "vitest";
import { ancestors, buildTree, matchingRows, visibleRows, type Row } from "../tree";

const FILES = ["README.md", "src/App.tsx", "src/files/tree.ts", "src/main.tsx", "Cargo.toml", "docs/a.md", "b.txt"];

const shown = (rows: Row[]) => rows.map(({ node, depth }) => `${"  ".repeat(depth)}${node.name}${node.children ? "/" : ""}`);

describe("buildTree", () => {
  it("lists folders before files, each by name without case", () => {
    const tree = buildTree(FILES, new Set());
    expect(shown(visibleRows(tree, new Set()))).toEqual(["docs/", "src/", "b.txt", "Cargo.toml", "README.md"]);
  });

  it("counts changed files up through every folder holding them", () => {
    const tree = buildTree(FILES, new Set(["src/files/tree.ts", "src/main.tsx", "b.txt"]));
    expect(tree.changed).toBe(3);
    const src = tree.children!.find((n) => n.name === "src")!;
    expect(src.changed).toBe(2);
    expect(src.children!.find((n) => n.name === "files")!.changed).toBe(1);
    expect(tree.children!.find((n) => n.name === "docs")!.changed).toBe(0);
  });
});

describe("visibleRows", () => {
  it("shows the children of open folders only, indented", () => {
    const tree = buildTree(FILES, new Set());
    expect(shown(visibleRows(tree, new Set(["src", "src/files", "docs/nope"])))).toEqual([
      "docs/",
      "src/",
      "  files/",
      "    tree.ts",
      "  App.tsx",
      "  main.tsx",
      "b.txt",
      "Cargo.toml",
      "README.md",
    ]);
  });
});

describe("matchingRows", () => {
  const tree = buildTree(FILES, new Set());

  it("keeps matching files and the folders on their way, open", () => {
    expect(shown(matchingRows(tree, "TREE"))).toEqual(["src/", "  files/", "    tree.ts"]);
  });

  it("matches names, not folders, until the query holds a slash", () => {
    expect(matchingRows(tree, "src")).toEqual([]);
    expect(shown(matchingRows(tree, "src/m"))).toEqual(["src/", "  main.tsx"]);
  });
});

describe("ancestors", () => {
  it("gives the folders outermost first", () => {
    expect(ancestors("a/b/c")).toEqual(["a", "a/b"]);
    expect(ancestors("c")).toEqual([]);
  });
});
