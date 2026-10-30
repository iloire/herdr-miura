import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../protocol";
import { catalog } from "../catalog";
import { DEFAULT_SETTINGS } from "../settings";

const calls: { command: string; args: Record<string, unknown> }[] = [];
let nextId = 0;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    return command === "request" ? `tauri-${++nextId}` : undefined;
  },
}));

vi.stubGlobal("document", { documentElement: { style: { setProperty: () => {} } } });

const { Controller } = await import("../controller");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const snapshot = {
  boot_id: "b",
  revision: 1,
  focused_workspace_id: "w1",
  focused_tab_id: null,
  focused_pane_id: null,
  workspaces: [{ workspace_id: "w1" }],
  tabs: [],
  panes: [],
  agents: [],
} as unknown as Snapshot;

async function connected(command: string | null) {
  const controller = new Controller();
  controller.applySettings({ ...DEFAULT_SETTINGS, newTabCommand: command });
  await controller.setSurface({ cols: 80, rows: 24, cell_width_px: 8, cell_height_px: 16 });
  const channel = calls.find((c) => c.command === "connect")?.args.events as { onmessage: (event: unknown) => void };
  channel.onmessage({ type: "snapshot", snapshot });
  return { controller, emit: channel.onmessage };
}

/// The new tab's answer, then what was typed into its pane.
async function typedAfterAnswer(emit: (event: unknown) => void) {
  await flush();
  const request = calls.filter((c) => c.command === "request").at(-1);
  expect(request?.args.method).toBe("tab.create");
  emit({ type: "response", request_id: `tauri-${nextId}`, response: { result: { root_pane: { pane_id: "p" } } } });
  await flush();
  return calls.filter((c) => c.command === "send_input");
}

describe("opening a tab", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("gives ⌘⇧T what the + does, and leaves ⌘T plain", () => {
    expect(catalog(true).find((e) => e.name === "new_command_tab")?.shortcuts).toEqual(["cmd-shift-t"]);
    expect(catalog(true).find((e) => e.name === "new_tab")?.shortcuts).toEqual(["cmd-t"]);
  });

  it("types the command into the tab new_command_tab opens", async () => {
    const { controller, emit } = await connected("claude");
    controller.run("new_command_tab");
    expect(await typedAfterAnswer(emit)).toHaveLength(1);
  });

  it("types nothing into the tab new_tab opens, with a command set", async () => {
    const { controller, emit } = await connected("claude");
    controller.run("new_tab");
    expect(await typedAfterAnswer(emit)).toHaveLength(0);
  });
});
