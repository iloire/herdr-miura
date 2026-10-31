import { describe, expect, it, vi } from "vitest";
import { MAX_HIGHLIGHT_CHARS, MAX_TOKENIZED_LINE, SLICE_CHARS, type Token, highlight, languageOf } from "../highlight";

// A grammar whose chunk cannot load, as a failed dynamic import looks.
vi.mock("@shikijs/langs/go", () => {
  throw new Error("no such chunk");
});

const joined = (tokens: Token[][]) => tokens.map((line) => line.map((token) => token.content).join("")).join("\n");

describe("languageOf", () => {
  it("goes by extension, in any case, at any depth", () => {
    for (const [path, language] of [
      ["src/daemon.ts", "typescript"],
      ["src/App.tsx", "tsx"],
      ["a/b.mjs", "javascript"],
      ["a.jsx", "jsx"],
      ["package.json", "json"],
      ["src-tauri/src/main.rs", "rust"],
      ["tool.py", "python"],
      ["main.go", "go"],
      ["install.sh", "shellscript"],
      ["x.zsh", "shellscript"],
      ["index.htm", "html"],
      ["styles.css", "css"],
      ["README.md", "markdown"],
      ["README.MD", "markdown"],
      ["ci.yml", "yaml"],
      ["Cargo.toml", "toml"],
      ["schema.sql", "sql"],
      ["app.rb", "ruby"],
      ["a.c", "c"],
      ["a.h", "c"],
      ["a.cc", "cpp"],
      ["A.java", "java"],
      ["a.swift", "swift"],
      ["rules.mk", "make"],
    ]) {
      expect(languageOf(path), path).toBe(language);
    }
  });

  it("goes by well-known names before any extension", () => {
    for (const [path, language] of [
      ["Dockerfile", "dockerfile"],
      ["deploy/Containerfile", "dockerfile"],
      ["Makefile", "make"],
      ["sub/GNUmakefile", "make"],
      ["Gemfile", "ruby"],
      [".zshrc", "shellscript"],
      ["home/.bashrc", "shellscript"],
      ["Cargo.lock", "toml"],
    ]) {
      expect(languageOf(path), path).toBe(language);
    }
  });

  it("leaves everything else plain", () => {
    for (const path of ["LICENSE", "notes.txt", "a.unknown", "archive.tar.gz", "ts", "dir.ts/README", ".gitignore", "x."]) {
      expect(languageOf(path), path).toBeUndefined();
    }
  });

  it("is not fooled by names on a prototype", () => {
    for (const path of ["constructor", "__proto__", "a.constructor", "a.toString", "a.__proto__"]) {
      expect(languageOf(path), path).toBeUndefined();
    }
  });
});

describe("highlight", () => {
  it("tokenizes with the theme's variables, keeping every character", async () => {
    const code = [
      "// a comment",
      'const greeting: string = "hi <b>&amp;</b>";',
      "",
      "\tfunction add(a: number) { return a + 1; }",
      "   ",
      "`${greeting}`",
      "",
    ].join("\n");
    const tokens = await highlight(code, "a.ts");
    expect(tokens).not.toBeNull();
    expect(joined(tokens!)).toBe(code);
    expect(tokens).toHaveLength(code.split("\n").length);
    const colors = new Set(tokens!.flat().map((token) => token.color));
    expect(colors.size).toBeGreaterThan(2);
    for (const color of colors) expect(color).toMatch(/^var\(--code-[a-z-]+\)$/);
  });

  it("colors a Markdown heading, which the stock theme leaves to bold", async () => {
    const tokens = await highlight("# Title\n\nwords\n", "a.md");
    const title = tokens![0].find((token) => token.content.includes("Title"));
    expect(title?.color).toBe("var(--code-token-function)");
  });

  it("compiles every language on the JS engine", async () => {
    const sample = 'a = "b" // c\nfoo(1)\n';
    for (const path of [
      "a.ts", "a.tsx", "a.js", "a.jsx", "a.json", "a.rs", "a.py", "a.sh", "a.html", "a.css", "a.md",
      "a.yml", "a.toml", "a.sql", "a.rb", "a.c", "a.cpp", "a.java", "a.swift", "Dockerfile", "Makefile",
    ]) {
      const tokens = await highlight(sample, path);
      expect(tokens && joined(tokens), path).toBe(sample);
    }
  });

  it("colors a grammar's first file as fully as its second", async () => {
    // Regexes compile on first use, which must not cut a line short. C++ has the slowest.
    const code = "#include <vector>\ntemplate <typename T> class Box { T value; };\nint main() { return 0; } // done\n";
    const first = await highlight(code, "first.cpp");
    expect(first).toEqual(await highlight(code, "second.cpp"));
  });

  it("keeps an unknown language plain", async () => {
    expect(await highlight("anything", "notes.txt")).toBeNull();
  });

  it("keeps a file over the limit plain, and takes one at the limit", async () => {
    const line = "x\n";
    expect(await highlight(line.repeat(MAX_HIGHLIGHT_CHARS / line.length + 1), "a.json")).toBeNull();
    expect(await highlight(line.repeat(MAX_HIGHLIGHT_CHARS / line.length), "a.json")).not.toBeNull();
  });

  it("draws a too-long line plain, and its neighbours still in color", async () => {
    const long = `const a = "${"x".repeat(MAX_TOKENIZED_LINE)}";`;
    const code = `const b = 1;\n${long}\nconst c = 2;`;
    const tokens = await highlight(code, "a.ts");
    expect(joined(tokens!)).toBe(code);
    expect(tokens![1]).toHaveLength(1);
    expect(tokens![2].length).toBeGreaterThan(1);
  });

  it("loses nothing where slices meet, even inside a block comment", async () => {
    const filler = "const a = 1;\n".repeat(Math.ceil(SLICE_CHARS / 13) - 2);
    // Sized so the comment opens in one slice and closes in the next.
    const code = `${filler}/* opens\n${"still a comment\n".repeat(400)}closes */\nconst b = 2;\n`;
    const tokens = await highlight(code, "a.ts");
    expect(joined(tokens!)).toBe(code);
    expect(tokens).toHaveLength(code.split("\n").length);
    const lines = code.split("\n");
    for (const [i, text] of lines.entries()) {
      if (text !== "still a comment") continue;
      expect(tokens![i].map((token) => token.color), `line ${i}`).toEqual(["var(--code-token-comment)"]);
    }
    expect(tokens![lines.indexOf("const b = 2;")][0].color).toBe("var(--code-token-keyword)");
  });

  it("stops tokenizing as soon as the file is left", async () => {
    const left = new AbortController();
    const pending = highlight("const a = 1;\n".repeat(SLICE_CHARS), "a.ts", left.signal);
    setTimeout(() => left.abort(), 30);
    expect(await pending).toBeNull();
  });

  it("falls back to plain when a grammar will not load", async () => {
    expect(await highlight("package main", "main.go")).toBeNull();
    // The next file is unharmed.
    expect(await highlight("let a = 1;", "a.js")).not.toBeNull();
  });

  it("drops a result whose file was left before it was ready", async () => {
    const left = new AbortController();
    const pending = highlight("const a = 1;", "a.ts", left.signal);
    left.abort();
    expect(await pending).toBeNull();
  });
});
