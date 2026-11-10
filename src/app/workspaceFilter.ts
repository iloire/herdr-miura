// Narrowing the sidebar to the workspaces whose text matches what you type: a
// workspace's name, folder and branch, and the names of the tabs and agents in
// it. Every word typed must appear somewhere, in any case and any order.

import type { Snapshot, Workspace } from "../protocol";

/// The words in `query`, lowercased; none when it is blank.
export function filterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/// The text a workspace is found by, lowercased.
export function workspaceText(workspace: Workspace, snapshot: Snapshot, folder: string | null): string {
  const id = workspace.workspace_id;
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === id).map((tab) => tab.label);
  const agents = snapshot.agents
    .filter((agent) => agent.workspace_id === id)
    .flatMap((agent) => [agent.name, agent.title, agent.terminal_title_stripped]);
  return [workspace.label, folder, workspace.branch, ...tabs, ...agents]
    .filter((part): part is string => !!part)
    .join("\n")
    .toLowerCase();
}

/// Whether `text` holds every one of `terms`.
export function matchesTerms(text: string, terms: readonly string[]): boolean {
  return terms.every((term) => text.includes(term));
}
