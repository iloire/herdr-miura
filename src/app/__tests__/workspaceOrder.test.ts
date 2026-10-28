import { describe, expect, it } from "vitest";
import type { AgentStatus, Workspace } from "../../protocol";
import { dropSlot, loadSort, moveIndex, saveSort, sortWorkspaces } from "../workspaceOrder";

function workspace(workspace_id: string, agent_status: AgentStatus): Workspace {
  return {
    workspace_id,
    active_tab_id: "t",
    new_workspace_cwd: "/",
    number: 1,
    label: workspace_id,
    custom_label: false,
    branch: null,
    git_ahead_behind: null,
    tokens: [],
    worktree: null,
    focused: false,
    agent_status,
  };
}

const ids = (list: Workspace[]) => list.map((w) => w.workspace_id);

describe("sortWorkspaces", () => {
  const list = [
    workspace("a", "idle"),
    workspace("b", "working"),
    workspace("c", "blocked"),
    workspace("d", "done"),
    workspace("e", "blocked"),
    workspace("f", "unknown"),
  ];

  it("keeps the daemon's order by hand", () => {
    expect(ids(sortWorkspaces(list, "manual"))).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("puts what needs you first, keeping the daemon's order within a status", () => {
    expect(ids(sortWorkspaces(list, "attention"))).toEqual(["c", "e", "d", "b", "a", "f"]);
  });

  it("does not reorder the snapshot's own list", () => {
    sortWorkspaces(list, "attention");
    expect(ids(list)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("dropSlot", () => {
  const rows = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it("splits each row at its middle", () => {
    expect(dropSlot(-5, rows)).toBe(0);
    expect(dropSlot(19, rows)).toBe(0);
    expect(dropSlot(21, rows)).toBe(1);
    expect(dropSlot(61, rows)).toBe(2);
    expect(dropSlot(101, rows)).toBe(3);
    expect(dropSlot(500, rows)).toBe(3);
  });
});

describe("moveIndex", () => {
  it("is nothing when the row lands where it is", () => {
    expect(moveIndex(2, 2)).toBeNull();
    expect(moveIndex(2, 3)).toBeNull();
  });

  it("counts the gap with the row still in place", () => {
    expect(moveIndex(2, 0)).toBe(0);
    expect(moveIndex(0, 3)).toBe(3);
    expect(moveIndex(0, 2)).toBe(2);
  });
});

describe("loadSort and saveSort", () => {
  it("round-trips the sort and defaults to manual", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadSort(storage)).toBe("manual");
    saveSort("attention", storage);
    expect(loadSort(storage)).toBe("attention");
  });

  it("falls back to manual when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSort(throwing)).toBe("manual");
  });
});
