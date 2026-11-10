import { describe, expect, it } from "vitest";
import { filterTerms, matchesTerms, workspaceText } from "../workspaceFilter";
import type { Agent, Snapshot, Tab, Workspace } from "../../protocol";

const workspace = { workspace_id: "w1", label: "Venturi Code", branch: "feat/vouchers" } as Workspace;
const snapshot = {
  tabs: [
    { workspace_id: "w1", label: "Christmas vouchers" },
    { workspace_id: "w2", label: "elsewhere" },
  ] as Tab[],
  agents: [
    { workspace_id: "w1", name: "claude", title: "Fix the Stripe webhook", terminal_title_stripped: null },
    { workspace_id: "w2", name: "codex", title: "Unrelated", terminal_title_stripped: null },
  ] as Agent[],
} as Snapshot;

describe("workspace filter", () => {
  it("splits the query into lowercased words", () => {
    expect(filterTerms("  Stripe   HOOK ")).toEqual(["stripe", "hook"]);
    expect(filterTerms("   ")).toEqual([]);
  });

  it("finds a workspace by its name, folder, branch, tabs and agents", () => {
    const text = workspaceText(workspace, snapshot, "/code/venturi");
    for (const query of ["venturi", "/code/ven", "vouchers", "christmas", "stripe webhook", "CLAUDE"]) {
      expect(matchesTerms(text, filterTerms(query)), query).toBe(true);
    }
  });

  it("needs every word, and looks only at the workspace's own tabs and agents", () => {
    const text = workspaceText(workspace, snapshot, null);
    expect(matchesTerms(text, filterTerms("venturi missing"))).toBe(false);
    expect(matchesTerms(text, filterTerms("elsewhere"))).toBe(false);
    expect(matchesTerms(text, filterTerms("codex"))).toBe(false);
  });

  it("matches everything when nothing is typed", () => {
    expect(matchesTerms("", [])).toBe(true);
  });
});
