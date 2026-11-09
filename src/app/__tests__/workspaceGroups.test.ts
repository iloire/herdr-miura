import { describe, expect, it } from "vitest";
import { groupNames, groupSections, loadCollapsed, renameGroup, saveCollapsed, workspaceGroups } from "../workspaceGroups";
import type { Workspace } from "../../protocol";

const workspace = (id: string, focused = false) => ({ workspace_id: id, label: id, focused }) as Workspace;
const roots: Record<string, string> = { main: "/code/app", tree: "/code/app-tree", notes: "/notes", web: "/code/web" };
const rootOf = (w: Workspace) => roots[w.workspace_id] ?? null;
const main = workspace("main");
const rows = [
  { workspace: workspace("web"), parent: null },
  { workspace: main, parent: null },
  { workspace: workspace("tree"), parent: main },
  { workspace: workspace("notes"), parent: null },
  { workspace: workspace("remote"), parent: null },
];
const groups = { "/code/app#main": "Work", "/notes#notes": "Life", "/code/web#web": "Work", "/code/app-tree#tree": "Life" };

describe("workspace groups", () => {
  it("keys a workspace by folder and name, and a worktree by its main checkout", () => {
    const byId = workspaceGroups(rows, rootOf, groups);
    expect(Object.fromEntries(byId)).toEqual({ web: "Work", main: "Work", tree: "Work", notes: "Life" });
  });

  it("lists the ungrouped first, then groups in the order their first row comes", () => {
    const sections = groupSections(rows, workspaceGroups(rows, rootOf, groups));
    expect(sections.map((s) => [s.name, s.rows.map((r) => r.workspace.workspace_id)])).toEqual([
      [null, ["remote"]],
      ["Work", ["web", "main", "tree"]],
      ["Life", ["notes"]],
    ]);
    expect(groupSections(rows, new Map()).map((s) => s.name)).toEqual([null]);
  });

  it("names groups once, sorted, and renames or ungroups every member", () => {
    expect(groupNames(groups)).toEqual(["Life", "Work"]);
    expect(renameGroup(groups, "Work", "Job")).toEqual([
      ["/code/app#main", "Job"],
      ["/code/web#web", "Job"],
    ]);
    expect(renameGroup(groups, "Life", null)).toEqual([
      ["/notes#notes", null],
      ["/code/app-tree#tree", null],
    ]);
  });

  it("remembers folded groups, and starts with none on bad storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveCollapsed(new Set(["Work"]), storage);
    expect(loadCollapsed(storage)).toEqual(new Set(["Work"]));
    expect(loadCollapsed({ getItem: () => "{nope" })).toEqual(new Set());
  });
});
