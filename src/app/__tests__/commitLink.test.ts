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
  commit: { sha: "d0de2cf".padEnd(40, "0"), short: "d0de2cf", subject: "s", author: "a", time: 0, refs: [], additions: null, deletions: null },
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

describe("openFileLink", () => {
  const settled = () => new Promise((done) => setTimeout(done));

  it("asks from the pane holding the text, opens the Files panel and hands the file on", async () => {
    const found = { root: "/repo/worktree", path: "docs/plan.md" };
    invoke.mockReset();
    invoke.mockImplementation(async (command) => (command === "find_file" ? found : undefined));
    const controller = new Controller();
    controller.getState().snapshot = snapshot();
    controller.getState().changes = true;
    const shown = vi.fn();
    controller.showFile = shown;
    vi.spyOn(controller, "request").mockImplementation(() => {});
    controller.openFileLink("docs/plan.md", "p2");
    await settled();
    expect(invoke).toHaveBeenCalledWith("find_file", { directory: "/repo/worktree", name: "docs/plan.md" });
    expect(shown).toHaveBeenCalledWith(found, "/repo/worktree");
    expect(controller.getState()).toMatchObject({ files: true, changes: false });
  });

  it("says so when the text is no file", async () => {
    invoke.mockReset();
    invoke.mockImplementation(async () => null);
    const controller = new Controller();
    controller.getState().snapshot = snapshot();
    const shown = vi.fn();
    controller.showFile = shown;
    controller.openFileLink("and/or", "p1");
    await settled();
    expect(shown).not.toHaveBeenCalled();
    expect(controller.getState().notice).toBe("No file and/or from /repo");
    expect(controller.getState().files).toBe(false);
  });
});

describe("openFileLink outside any checkout", () => {
  const settled = () => new Promise((done) => setTimeout(done));
  const outside = (path: string, image: unknown = undefined, folder = false) => {
    invoke.mockReset();
    invoke.mockImplementation(async (command) => {
      if (command === "locate_file") return { path, folder };
      if (command === "read_link_image") return image;
      return command === "find_file" ? null : undefined;
    });
    const controller = new Controller();
    controller.getState().snapshot = snapshot();
    controller.showFile = vi.fn();
    return controller;
  };

  it("shows an image over the window, named by its file", async () => {
    const controller = outside("/tmp/x/preview.png", { type: "image", mime: "image/png", data: "aW1n" });
    controller.openFileLink("/tmp/x/preview.png", "p1");
    await settled();
    expect(invoke).toHaveBeenCalledWith("locate_file", { directory: "/repo", name: "/tmp/x/preview.png" });
    expect(invoke).toHaveBeenCalledWith("read_link_image", { path: "/tmp/x/preview.png" });
    expect(controller.getState().pastedImage).toEqual({ mime: "image/png", data: "aW1n", title: "preview.png" });
    expect(controller.getState().files).toBe(false);
  });

  it("opens anything else in its default app", async () => {
    const controller = outside("/tmp/x/report.pdf");
    controller.openFileLink("/tmp/x/report.pdf", "p1");
    await settled();
    expect(invoke).toHaveBeenCalledWith("open_link_file", { path: "/tmp/x/report.pdf", with: "default" });
    expect(controller.getState().pastedImage).toBeNull();
  });

  it("shows a folder in the file manager", async () => {
    const controller = outside("/tmp/x", undefined, true);
    controller.openFileLink("~/x", "p1");
    await settled();
    expect(invoke).toHaveBeenCalledWith("open_link_file", { path: "/tmp/x", with: "reveal" });
    expect(controller.getState().notice).toBeNull();
  });
});

describe("openImageLink", () => {
  const SESSION = "d0aa0621-ac48-4225-9ee8-e1d0fcacb836";
  const settled = () => new Promise((done) => setTimeout(done));
  let controller: InstanceType<typeof Controller>;
  let answer: { mime: string; data: string } | null;

  beforeEach(() => {
    answer = { mime: "image/png", data: "aW1n" };
    invoke.mockReset();
    invoke.mockImplementation(async (command) => (command === "pasted_image" ? answer : undefined));
    controller = new Controller();
    controller.getState().snapshot = {
      ...snapshot(),
      agents: [{ pane_id: "p2", tokens: [["$claude_session", SESSION]] }],
    } as unknown as Snapshot;
  });

  it("reads the image from the session of the pane holding the text", async () => {
    const focus = vi.spyOn(controller, "request").mockImplementation(() => {});
    controller.openImageLink(3, "p2");
    expect(focus).toHaveBeenCalledWith("pane.focus", { pane_id: "p2" });
    await settled();
    expect(invoke).toHaveBeenCalledWith("pasted_image", { session: SESSION, paste: 3 });
    expect(controller.getState().pastedImage).toEqual({ mime: "image/png", data: "aW1n", title: "Image #3" });
  });

  it("says so when no prompt holds the image", async () => {
    vi.spyOn(controller, "request").mockImplementation(() => {});
    answer = null;
    controller.openImageLink(3, "p2");
    await settled();
    expect(controller.getState().pastedImage).toBeNull();
    expect(controller.getState().notice).toBe("Image #3 is not in this session's transcript");
  });

  it("says so in a pane with no session, without reading anything", () => {
    controller.openImageLink(1, "p1");
    expect(invoke).not.toHaveBeenCalledWith("pasted_image", expect.anything());
    expect(controller.getState().notice).toBe("No Claude Code session in this pane to read the image from");
  });
});
