// Named groups of workspaces in the sidebar, each one folding away so the list
// shows only the work in hand. The daemon knows a flat list, so a workspace's
// group lives in the settings file's `workspace_groups`, keyed by folder and
// name as `workspace_colors` is (`colorKey`). Which groups are folded is this
// window's, kept in its storage as the open cards are.

import type { Workspace } from "../protocol";
import { colorKey } from "./hue";
import type { Row } from "./worktreeGroups";

/// A run of rows under one header; `name` is null for the ungrouped ones, which
/// come first and have no header.
export interface Section {
  name: string | null;
  rows: Row[];
}

/// Every grouped workspace's group, by workspace id: its own, or for a worktree
/// its main checkout's, which alone can be put in one. A workspace without a
/// local root has no key to keep it under, so it stays ungrouped.
export function workspaceGroups(
  rows: readonly Row[],
  rootOf: (workspace: Workspace) => string | null,
  groups: Readonly<Record<string, string>>,
): Map<string, string> {
  const byId = new Map<string, string>();
  for (const { workspace, parent } of rows) {
    const owner = parent ?? workspace;
    const root = rootOf(owner);
    const group = root === null ? undefined : groups[colorKey(root, owner.label)];
    if (group) byId.set(workspace.workspace_id, group);
  }
  return byId;
}

/// `rows` split into sections: the ungrouped first, then each group in the
/// order its first row comes, every row keeping its order within.
export function groupSections(rows: readonly Row[], groupOf: ReadonlyMap<string, string>): Section[] {
  const ungrouped: Section = { name: null, rows: [] };
  const named = new Map<string, Section>();
  for (const row of rows) {
    const name = groupOf.get(row.workspace.workspace_id);
    if (name === undefined) {
      ungrouped.rows.push(row);
      continue;
    }
    let section = named.get(name);
    if (!section) named.set(name, (section = { name, rows: [] }));
    section.rows.push(row);
  }
  return [ungrouped, ...named.values()].filter((section) => section.rows.length > 0);
}

/// The group names in use, sorted, for the Move to Group menu.
export function groupNames(groups: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.values(groups))].sort((a, b) => a.localeCompare(b));
}

/// The entries that rename group `from` to `to`; `to` null ungroups them all.
export function renameGroup(groups: Readonly<Record<string, string>>, from: string, to: string | null): [string, string | null][] {
  return Object.entries(groups)
    .filter(([, name]) => name === from)
    .map(([key]) => [key, to]);
}

const KEY = "workspace-groups-collapsed";

export function loadCollapsed(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Set<string> {
  try {
    const names: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(names) ? names.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(names: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify([...names]));
  } catch {
    // A group that does not stay folded is only a convenience lost.
  }
}
