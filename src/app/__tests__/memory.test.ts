import { describe, expect, it } from "vitest";
import type { Pane, Tab } from "../../protocol";
import { formatBytes, type PaneMemory, type PaneProcess, sameMemory, scopeProcesses, totalBytes } from "../memory";

const MB = 1024 * 1024;

const proc = (pid: number, mb: number): PaneProcess => ({ pid, name: `p${pid}`, command: `p${pid}`, bytes: mb * MB });

const pane = (pane_id: string, tab_id: string, workspace_id = "w1"): Pane => ({
  pane_id,
  workspace_id,
  tab_id,
  label: null,
  cwd: null,
  foreground_cwd: null,
  focused: false,
  right_click_passthrough: false,
});

const tab = (tab_id: string, label: string): Tab => ({
  tab_id,
  workspace_id: "w1",
  number: 1,
  label,
  custom_label: false,
  zoomed: false,
  focused: false,
  agent_status: "idle",
});

describe("scopeProcesses", () => {
  const panes = [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t2"), pane("w2:p1", "w2:t1", "w2")];
  const tabs = [tab("w1:t1", "api"), tab("w1:t2", "web")];
  const memory: PaneMemory = new Map([
    ["w1:p1", [proc(1, 300), proc(2, 10)]],
    ["w1:p2", [proc(3, 500)]],
    ["w2:p1", [proc(4, 900)]],
  ]);

  it("lists a tab's processes, largest first", () => {
    expect(scopeProcesses(memory, panes, tabs, { kind: "tab", id: "w1:t1" }).map((p) => p.pid)).toEqual([1, 2]);
  });

  it("lists a workspace's across its tabs, naming each tab", () => {
    const rows = scopeProcesses(memory, panes, tabs, { kind: "workspace", id: "w1" });
    expect(rows.map((p) => [p.pid, p.tab])).toEqual([
      [3, "web"],
      [1, "api"],
      [2, "api"],
    ]);
    expect(totalBytes(rows)).toBe(810 * MB);
  });
});

describe("sameMemory", () => {
  it("ignores changes under a megabyte", () => {
    const a: PaneMemory = new Map([["p", [proc(1, 100)]]]);
    expect(sameMemory(a, new Map([["p", [{ ...proc(1, 100), bytes: 100 * MB + 1000 }]]]))).toBe(true);
    expect(sameMemory(a, new Map([["p", [proc(1, 120)]]]))).toBe(false);
    expect(sameMemory(a, new Map([["p", [proc(2, 100)]]]))).toBe(false);
  });
});

describe("formatBytes", () => {
  it("writes megabytes and gigabytes", () => {
    expect(formatBytes(812 * MB)).toBe("812 MB");
    expect(formatBytes(1434 * MB)).toBe("1.4 GB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});
