import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
const answers: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    return answers[command];
  },
}));

const { Controller } = await import("../controller");

const surface = { cols: 80, rows: 24, cell_width_px: 8, cell_height_px: 16 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/// The event channel the last `connect` handed the bridge.
function lastChannel(): { onmessage: (event: unknown) => void } {
  const connect = calls.filter((c) => c.command === "connect").at(-1);
  return connect?.args.events as { onmessage: (event: unknown) => void };
}

describe("one host at a time", () => {
  beforeEach(() => {
    calls.length = 0;
    for (const key of Object.keys(answers)) delete answers[key];
  });

  it("connects to the picked host and back to this machine", async () => {
    const controller = new Controller();
    await controller.setSurface(surface);
    expect(calls.at(-1)).toMatchObject({ command: "connect", args: { host: null } });
    await controller.connectTo("box");
    expect(calls.at(-1)).toMatchObject({ command: "connect", args: { host: "box" } });
    expect(controller.getState().host).toBe("box");
    await controller.connectTo(null);
    expect(calls.at(-1)).toMatchObject({ command: "connect", args: { host: null } });
  });

  it("asks before trusting an unknown key, and only after showing it", async () => {
    const fingerprints = [{ keyType: "ED25519", fingerprint: "SHA256:abc" }];
    answers.scan_host_key = fingerprints;
    const controller = new Controller();
    await controller.setSurface(surface);
    await controller.connectTo("box");

    lastChannel().onmessage({ type: "unknown_host_key", host: "box" });
    expect(controller.getState().hostKey).toEqual({ host: "box", fingerprints: null, error: null });
    await controller.trustHostKey();
    expect(calls.some((c) => c.command === "trust_host_key")).toBe(false);

    await flush();
    expect(controller.getState().hostKey?.fingerprints).toEqual(fingerprints);
    await controller.trustHostKey();
    expect(calls.find((c) => c.command === "trust_host_key")?.args).toEqual({ host: "box" });
    expect(controller.getState().hostKey).toBeNull();
    expect(calls.at(-1)).toMatchObject({ command: "connect", args: { host: "box" } });
  });

  it("declining leaves known_hosts alone", async () => {
    answers.scan_host_key = [{ keyType: "ED25519", fingerprint: "SHA256:abc" }];
    const controller = new Controller();
    await controller.setSurface(surface);
    lastChannel().onmessage({ type: "unknown_host_key", host: "box" });
    await flush();
    controller.dismissHostKey();
    expect(controller.getState().hostKey).toBeNull();
    expect(calls.some((c) => c.command === "trust_host_key")).toBe(false);
  });
});
