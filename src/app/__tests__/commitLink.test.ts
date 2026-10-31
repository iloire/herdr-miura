import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FoundCommit } from "../../changes/store";
import type { Snapshot } from "../../protocol";

const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>(async () => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke,
}));

const { Controller } = await import("../controller");

const FOUND: FoundCommit = {
  checkout: "/repo",
  commit: { sha: "d0de2cf".padEnd(40, "0"), short: "d0de2cf", subject: "s", author: "a", time: 0, refs: [] },
};

function snapshot(): Snapshot {
  return {
    focused_pane_id: "p1",
    panes: [
      { pane_id: "p1", cwd: "/repo" },
      { pane_id: "p2", cwd: "/shell", foreground_cwd: "/repo/worktree" },
    ],
  } as unknown as Snapshot;
}

describe("openCommitLink", () => {
  let controller: InstanceType<typeof Controller>;
  let shown: ReturnType<typeof vi.fn<(found: FoundCommit) => void>>;
  let answer: FoundCommit | null;

  const settled = () => new Promise((done) => setTimeout(done));

  beforeEach(() => {
    answer = FOUND;
    invoke.mockReset();
    invoke.mockImplementation(async (command) => (command === "find_commit" ? answer : undefined));
    controller = new Controller();
    controller.getState().snapshot = snapshot();
    shown = vi.fn<(found: FoundCommit) => void>();
    controller.showCommit = shown;
  });

  it("asks Git from the pane holding the text, and opens the Changes panel over the Files panel", async () => {
    const focus = vi.spyOn(controller, "request").mockImplementation(() => {});
    controller.getState().files = true;
    controller.openCommitLink("d0de2cf", "p2");
    expect(focus).toHaveBeenCalledWith("pane.focus", { pane_id: "p2" });
    await settled();
    expect(invoke).toHaveBeenCalledWith("find_commit", { directory: "/repo/worktree", name: "d0de2cf" });
    expect(shown).toHaveBeenCalledWith(FOUND);
    expect(controller.getState()).toMatchObject({ changes: true, files: false });
  });

  it("does not refocus the pane that already has the focus", async () => {
    const focus = vi.spyOn(controller, "request").mockImplementation(() => {});
    controller.openCommitLink("d0de2cf", "p1");
    await settled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("leaves the panels alone and says so when no commit has that name", async () => {
    answer = null;
    controller.openCommitLink("1234567", "p1");
    await settled();
    expect(shown).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ changes: false, notice: "No commit 1234567 in /repo" });
  });
});
