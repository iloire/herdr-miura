import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke: async () => undefined,
}));

const { Controller } = await import("../controller");

describe("the panel commands", () => {
  let controller: InstanceType<typeof Controller>;
  let focusTerminal: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    controller = new Controller();
    focusTerminal = vi.fn<() => void>();
    controller.focusTerminal = focusTerminal;
  });

  it.each([
    ["review_changes", "changes"],
    ["browse_files", "files"],
    ["add_to_queue", "queue"],
  ] as const)("%s hands focus to the terminal when it closes the panel, not when it opens it", (command, panel) => {
    controller.run(command);
    expect(controller.getState()[panel]).toBe(true);
    expect(focusTerminal).not.toHaveBeenCalled();

    controller.run(command);
    expect(controller.getState()[panel]).toBe(false);
    expect(focusTerminal).toHaveBeenCalledOnce();
  });

  it("leaves the focus alone when a command swaps one open panel for another", () => {
    controller.run("review_changes");
    controller.run("browse_files");
    expect(controller.getState()).toMatchObject({ changes: false, files: true });
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("closes a queue panel that opened on its own", () => {
    controller.followQueue(true);
    expect(controller.getState()).toMatchObject({ queue: true, queueAuto: true });

    controller.run("add_to_queue");
    expect(controller.getState()).toMatchObject({ queue: false, queueAuto: false });
    expect(focusTerminal).toHaveBeenCalledOnce();
  });
});
