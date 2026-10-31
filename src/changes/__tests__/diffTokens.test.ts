import { describe, expect, it, vi } from "vitest";
import { type Token, highlight } from "../../files/highlight";
import { type ParsedDiff, parseUnified } from "../diff";
import { MAX_DIFF_CHARS, tokenizeDiff } from "../diffTokens";

const real = (code: string) => highlight(code, "a.ts");
const text = (line: Token[]) => line.map((token) => token.content).join("");
const colorOf = (line: Token[], content: string) => line.find((token) => token.content.includes(content))?.color;

const DIFF = parseUnified(
  [
    "@@ -1,4 +1,4 @@",
    " const a = 1;",
    "-const b = `open",
    "+const b = 2;",
    "+",
    " const c = 3;",
    "",
    "@@ -20,2 +20,2 @@ function f() {",
    " const d = 4;",
    "-const e = 5;",
    "+const e = 6;",
  ].join("\n"),
);

describe("tokenizeDiff", () => {
  it("puts each line's own tokens on it, across both sides and every hunk", async () => {
    const tokens = await tokenizeDiff(DIFF, real);
    expect(tokens?.map((hunk) => hunk.map(text))).toEqual(DIFF.hunks.map((hunk) => hunk.lines.map((line) => line.text)));
  });

  it("gives a line ending the hunk blank its place", async () => {
    const diff = parseUnified("@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n \n");
    const tokens = await tokenizeDiff(diff, real);
    expect(tokens?.[0].map(text)).toEqual(["const a = 1;", "const b = 2;", ""]);
  });

  it("does not read a removed line into the new side", async () => {
    // On one side only, the removed line's open template would swallow `c`.
    const [first] = (await tokenizeDiff(DIFF, real))!;
    expect(colorOf(first[4], "const")).toBe(colorOf(first[0], "const"));
  });

  it("does not let one hunk's open string run into the next", async () => {
    const diff = parseUnified("@@ -1 +1 @@\n+const a = `open\n@@ -9 +9 @@\n+const b = 2;\n");
    const [first, second] = (await tokenizeDiff(diff, real))!;
    expect(colorOf(second[0], "const")).toBe(colorOf(first[0], "const"));
  });

  it("does not ask for a side with no lines", async () => {
    const tokenize = vi.fn(real);
    await tokenizeDiff(parseUnified("@@ -0,0 +1 @@\n+const a = 1;\n"), tokenize);
    expect(tokenize.mock.calls).toEqual([["const a = 1;"]]);
  });

  it("stays plain, and stops asking, when the tokenizer says no", async () => {
    const tokenize = vi.fn(async () => null);
    expect(await tokenizeDiff(DIFF, tokenize)).toBeNull();
    expect(tokenize).toHaveBeenCalledTimes(1);
  });

  it("stays plain past the limit, counted over the whole diff", async () => {
    const line = { kind: "added" as const, oldNumber: null, newNumber: 1, text: "x".repeat(MAX_DIFF_CHARS / 2 + 1) };
    const diff: ParsedDiff = { hunks: [{ header: "", lines: [line] }, { header: "", lines: [line] }], binary: false, truncated: false };
    const tokenize = vi.fn(real);
    expect(await tokenizeDiff(diff, tokenize)).toBeNull();
    expect(tokenize).not.toHaveBeenCalled();
  });
});
