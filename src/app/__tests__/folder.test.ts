import { describe, expect, it } from "vitest";
import { tildePath } from "../folder";

describe("tildePath", () => {
  it("shows the home folder and paths under it with ~", () => {
    expect(tildePath("/Users/you", "/Users/you")).toBe("~");
    expect(tildePath("/Users/you/code/herdr-gpui", "/Users/you")).toBe("~/code/herdr-gpui");
    expect(tildePath("/Users/you/notes", "/Users/you/")).toBe("~/notes");
  });

  it("leaves other paths alone, including a sibling that shares the prefix", () => {
    expect(tildePath("/Users/youth/code", "/Users/you")).toBe("/Users/youth/code");
    expect(tildePath("/tmp", "/Users/you")).toBe("/tmp");
    expect(tildePath("/Users/you/code", null)).toBe("/Users/you/code");
  });
});
