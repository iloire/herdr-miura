import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, addedFile, clean, parseUnified } from "../diff";

const PATCH = `diff --git a/a.txt b/a.txt
index 5626abf..f719efd 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@ fn main
 one
-two
+TWO
 three
@@ -10,2 +10,3 @@
 ten
+ten and a half
 eleven
\\ No newline at end of file
`;

describe("parseUnified", () => {
  it("numbers old and new lines through each hunk", () => {
    const { hunks } = parseUnified(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe("fn main");
    expect(hunks[0].lines.map((l) => [l.kind, l.oldNumber, l.newNumber, l.text])).toEqual([
      ["context", 1, 1, "one"],
      ["removed", 2, null, "two"],
      ["added", null, 2, "TWO"],
      ["context", 3, 3, "three"],
    ]);
    expect(hunks[1].lines.map((l) => [l.oldNumber, l.newNumber])).toEqual([
      [10, 10],
      [null, 11],
      [11, 12],
    ]);
  });

  it("skips the no-newline marker", () => {
    const { hunks } = parseUnified(PATCH);
    expect(hunks[1].lines.some((l) => l.text.includes("No newline"))).toBe(false);
  });

  it("notices a binary file", () => {
    const parsed = parseUnified("diff --git a/x b/x\nBinary files a/x and b/x differ\n");
    expect(parsed.binary).toBe(true);
    expect(parsed.hunks).toEqual([]);
  });

  it("is empty for an empty diff", () => {
    expect(parseUnified("").hunks).toEqual([]);
  });
});

describe("clean", () => {
  it("drops controls and direction overrides", () => {
    expect(clean("a\u001b[31mb‮c⁦d")).toBe("a[31mbcd");
  });

  it("expands tabs", () => {
    expect(clean("\tx")).toBe("    x");
  });

  it("bounds a long line", () => {
    expect(clean("x".repeat(MAX_LINE_CHARS + 10))).toHaveLength(MAX_LINE_CHARS + 1);
  });
});

it("shows an untracked file as added lines", () => {
  const { hunks } = addedFile("a\nb\n");
  expect(hunks[0].lines.map((l) => [l.kind, l.newNumber, l.text])).toEqual([
    ["added", 1, "a"],
    ["added", 2, "b"],
  ]);
});
