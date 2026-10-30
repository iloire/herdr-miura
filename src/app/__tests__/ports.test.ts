import { describe, expect, it } from "vitest";
import type { Pane } from "../../protocol";
import { type ListeningPort, portRows, samePorts, tabPorts } from "../ports";

const port = (number: number, pane: string | null): ListeningPort => ({
  port: number,
  address: `*:${number}`,
  process: "node",
  url: `http://localhost:${number}/`,
  pane,
});

const pane = (pane_id: string, tab_id: string): Pane => ({
  pane_id,
  workspace_id: "w1",
  tab_id,
  label: null,
  cwd: null,
  foreground_cwd: null,
  focused: false,
  right_click_passthrough: false,
});

describe("tabPorts", () => {
  const panes = [pane("w1:p1", "w1:t1"), pane("w1:p2", "w1:t1"), pane("w1:p3", "w1:t2")];

  it("keeps the ports of the tab's panes, in order", () => {
    const ports = [port(3000, "w1:p2"), port(4000, "w1:p3"), port(5000, "w1:p1")];
    expect(tabPorts(ports, panes, "w1:t1").map((p) => p.port)).toEqual([3000, 5000]);
    expect(tabPorts(ports, panes, "w1:t2").map((p) => p.port)).toEqual([4000]);
  });

  it("follows a pane that moved to another tab", () => {
    const moved = [pane("w1:p1", "w1:t2")];
    expect(tabPorts([port(3000, "w1:p1")], moved, "w1:t2")).toHaveLength(1);
    expect(tabPorts([port(3000, "w1:p1")], moved, "w1:t1")).toHaveLength(0);
  });

  it("leaves out a listener whose pane is unknown", () => {
    const ports = [port(3000, null), port(4000, "w1:gone")];
    expect(tabPorts(ports, panes, "w1:t1")).toEqual([]);
  });
});

describe("samePorts", () => {
  const map = (...ports: ListeningPort[]) => new Map([["w1", ports]]);

  it("sees a port change panes", () => {
    expect(samePorts(map(port(3000, "w1:p1")), map(port(3000, "w1:p1")))).toBe(true);
    expect(samePorts(map(port(3000, "w1:p1")), map(port(3000, "w1:p2")))).toBe(false);
    expect(samePorts(map(port(3000, null)), map(port(3000, "w1:p1")))).toBe(false);
  });
});

describe("portRows", () => {
  const ports = (count: number) => Array.from({ length: count }, (_, i) => port(3000 + i, null));

  it("has nothing to list or hide without ports", () => {
    expect(portRows([])).toEqual({ rows: [], more: 0 });
  });

  it("lists three ports with none left out", () => {
    const three = ports(3);
    expect(portRows(three)).toEqual({ rows: three, more: 0 });
  });

  it("keeps the first three of four and counts the one left out", () => {
    const four = ports(4);
    expect(portRows(four)).toEqual({ rows: four.slice(0, 3), more: 1 });
  });
});
