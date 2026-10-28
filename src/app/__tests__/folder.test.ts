import { describe, expect, it } from "vitest";
import { tildePath } from "../folder";

describe("tildePath", () => {
  it("shows the home folder and paths under it with ~", () => {
    expect(tildePath("/Users/ivan", "/Users/ivan")).toBe("~");
    expect(tildePath("/Users/ivan/code/herdr-gpui", "/Users/ivan")).toBe("~/code/herdr-gpui");
    expect(tildePath("/Users/ivan/notes", "/Users/ivan/")).toBe("~/notes");
  });

  it("leaves other paths alone, including a sibling that shares the prefix", () => {
    expect(tildePath("/Users/ivanka/code", "/Users/ivan")).toBe("/Users/ivanka/code");
    expect(tildePath("/tmp", "/Users/ivan")).toBe("/tmp");
    expect(tildePath("/Users/ivan/code", null)).toBe("/Users/ivan/code");
  });
});
