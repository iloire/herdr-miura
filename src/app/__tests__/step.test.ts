import { describe, expect, it } from "vitest";
import type { Workspace } from "../../protocol";
import { stepWorkspace } from "../step";

const workspaces = ["a", "b", "c"].map((workspace_id) => ({ workspace_id }) as Workspace);
const step = (focused: string | null, delta: 1 | -1) => stepWorkspace(workspaces, focused, delta)?.workspace_id;

describe("stepWorkspace", () => {
  it("moves one row either way", () => {
    expect(step("b", 1)).toBe("c");
    expect(step("b", -1)).toBe("a");
  });

  it("wraps around both ends", () => {
    expect(step("c", 1)).toBe("a");
    expect(step("a", -1)).toBe("c");
  });

  it("starts from an end when nothing listed is focused", () => {
    expect(step(null, 1)).toBe("a");
    expect(step("gone", -1)).toBe("c");
  });

  it("has nowhere to go without workspaces", () => {
    expect(stepWorkspace([], "a", 1)).toBeNull();
  });
});
