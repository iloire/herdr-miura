import { describe, expect, it } from "vitest";
import { HUE_SLOTS, hue, hueColor, slotColor, workspaceHue, workspaceSlots } from "../hue";
import { activeTheme } from "../../themes/active";
import { css } from "../../terminal/theme";
import { legible } from "../../themes/chrome";
import type { Workspace } from "../../protocol";

describe("hue", () => {
  it("matches herdr-gpui's slots for the same names", () => {
    expect(["herdr-gpui", "notes", "dotfiles", "web-app", "herdr-tauri"].map(hue)).toEqual([1, 6, 1, 2, 3]);
  });

  it("keeps every name on a red-to-cyan slot and spreads names across them", () => {
    const slots = new Set(Array.from({ length: 60 }, (_, i) => hue(`project-${i}`)));
    for (const slot of slots) expect([1, 2, 3, 4, 5, 6]).toContain(slot);
    expect(slots.size).toBe(6);
  });

  it("writes the slot's ANSI color as CSS", () => {
    expect(hueColor("notes")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("a workspace's color", () => {
  const workspace = (id: string, label = id) => ({ workspace_id: id, label }) as Workspace;
  const roots: Record<string, string> = { main: "/code/app", tree: "/code/app-tree", other: "/code/other" };
  const rootOf = (w: Workspace) => roots[w.workspace_id] ?? null;
  const main = workspace("main");
  const rows = [
    { workspace: main, parent: null },
    { workspace: workspace("tree"), parent: main },
    { workspace: workspace("other"), parent: null },
    { workspace: workspace("remote"), parent: null },
  ];

  it("names the palette's red-to-cyan slots in order", () => {
    const { terminal, chrome } = activeTheme();
    HUE_SLOTS.forEach((slot, i) => expect(slotColor(slot)).toBe(css(legible(terminal.palette[i + 1], chrome.tokens))));
  });

  it("gives a chosen slot only to the workspace on that folder", () => {
    const slots = workspaceSlots(rows, rootOf, { "/code/other": "blue" });
    expect([...slots]).toEqual([["other", "blue"]]);
  });

  it("gives a worktree its main checkout's slot, over one set on its own folder", () => {
    const slots = workspaceSlots(rows, rootOf, { "/code/app": "green", "/code/app-tree": "red" });
    expect(slots.get("tree")).toBe("green");
    expect(workspaceSlots(rows, rootOf, { "/code/app-tree": "red" }).has("tree")).toBe(false);
  });

  it("uses the chosen slot, else the automatic hue of the name", () => {
    const name = "notes"; // Slot 6, cyan.
    const chosen = new Map([["w", "red" as const]]);
    expect(workspaceHue({ workspace_id: "w", label: name }, chosen)).toBe(slotColor("red"));
    expect(workspaceHue({ workspace_id: "x", label: name }, chosen)).toBe(hueColor(name));
    expect(slotColor("red")).not.toBe(hueColor(name));
  });
});
