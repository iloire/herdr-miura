// Syntax highlighting for read-only views: which language a file is, and code
// as colored tokens. It runs in a worker (files/offThread.ts), so Shiki's core
// and each grammar load on first use and none of it reaches the main bundle,
// and it uses the JS regex engine, so no WASM. Token colors are `var(--code-…)`,
// which the theme sets (themes/chrome.ts): switching theme repaints without
// tokenizing again. Every "no" here is `null` and the caller keeps its plain
// text. Code is untrusted: callers `clean` it and draw tokens as text, never
// as HTML.

import type { GrammarState, HighlighterCore, LanguageInput } from "@shikijs/core";

export interface Token {
  content: string;
  /// A `var(--code-…)` from `themes/chrome.ts`.
  color?: string;
}

interface Language {
  id: string;
  grammar: () => LanguageInput;
  extensions: string[];
  filenames?: string[];
}

const LANGUAGES: Language[] = [
  { id: "typescript", grammar: () => import("@shikijs/langs/typescript"), extensions: ["ts", "mts", "cts"] },
  { id: "tsx", grammar: () => import("@shikijs/langs/tsx"), extensions: ["tsx"] },
  { id: "javascript", grammar: () => import("@shikijs/langs/javascript"), extensions: ["js", "mjs", "cjs"] },
  { id: "jsx", grammar: () => import("@shikijs/langs/jsx"), extensions: ["jsx"] },
  { id: "json", grammar: () => import("@shikijs/langs/json"), extensions: ["json", "jsonc", "webmanifest"] },
  { id: "rust", grammar: () => import("@shikijs/langs/rust"), extensions: ["rs"] },
  { id: "python", grammar: () => import("@shikijs/langs/python"), extensions: ["py", "pyi"] },
  { id: "go", grammar: () => import("@shikijs/langs/go"), extensions: ["go"] },
  {
    id: "shellscript",
    grammar: () => import("@shikijs/langs/shellscript"),
    extensions: ["sh", "bash", "zsh"],
    filenames: [".bashrc", ".bash_profile", ".bash_aliases", ".profile", ".zshrc", ".zshenv", ".zprofile"],
  },
  { id: "html", grammar: () => import("@shikijs/langs/html"), extensions: ["html", "htm"] },
  { id: "css", grammar: () => import("@shikijs/langs/css"), extensions: ["css"] },
  { id: "markdown", grammar: () => import("@shikijs/langs/markdown"), extensions: ["md", "markdown", "mdx"] },
  { id: "yaml", grammar: () => import("@shikijs/langs/yaml"), extensions: ["yaml", "yml"] },
  {
    id: "toml",
    grammar: () => import("@shikijs/langs/toml"),
    extensions: ["toml"],
    filenames: ["Cargo.lock", "poetry.lock", "uv.lock"],
  },
  { id: "sql", grammar: () => import("@shikijs/langs/sql"), extensions: ["sql"] },
  {
    id: "ruby",
    grammar: () => import("@shikijs/langs/ruby"),
    extensions: ["rb", "rake", "gemspec"],
    filenames: ["Gemfile", "Rakefile", "Brewfile", "Vagrantfile"],
  },
  { id: "c", grammar: () => import("@shikijs/langs/c"), extensions: ["c", "h"] },
  { id: "cpp", grammar: () => import("@shikijs/langs/cpp"), extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"] },
  { id: "java", grammar: () => import("@shikijs/langs/java"), extensions: ["java"] },
  { id: "swift", grammar: () => import("@shikijs/langs/swift"), extensions: ["swift"] },
  {
    id: "dockerfile",
    grammar: () => import("@shikijs/langs/dockerfile"),
    extensions: ["dockerfile"],
    filenames: ["Dockerfile", "Containerfile"],
  },
  {
    id: "make",
    grammar: () => import("@shikijs/langs/make"),
    extensions: ["mk"],
    filenames: ["Makefile", "makefile", "GNUmakefile"],
  },
];

// Maps, not objects: a file called `x.constructor` must not find a prototype's.
const BY_EXTENSION = new Map(LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language])));
const BY_FILENAME = new Map(LANGUAGES.flatMap((language) => (language.filenames ?? []).map((name) => [name, language])));

/// The language `path` is written in, by its name and then its extension in
/// any case; `undefined` is plain text.
export function languageOf(path: string): string | undefined {
  return language(path)?.id;
}

function language(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return BY_FILENAME.get(name) ?? (dot < 0 ? undefined : BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()));
}

/// Past this the file stays plain: every token is a DOM node, drawn at once.
export const MAX_HIGHLIGHT_CHARS = 256 * 1024;
/// A longer line, usually minified, is drawn plain on its own: the file's other lines still get colors.
export const MAX_TOKENIZED_LINE = 5_000;
/// Tokenizing hands the thread back after about this much, up to 150 ms' worth
/// on minified code, so a file that was left stops. Exported for the tests.
export const SLICE_CHARS = 4 * 1024;

const THEME = "herdr";

let highlighter: Promise<HighlighterCore> | null = null;

function core(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createCssVariablesTheme, createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
    ]);
    const theme = createCssVariablesTheme({ name: THEME, variablePrefix: "--code-", fontStyle: false });
    // The theme leaves headings to bold, which `fontStyle: false` drops.
    theme.tokenColors!.push({ scope: "markup.heading", settings: { foreground: "var(--code-token-function)" } });
    return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return highlighter;
}

/// Whole lines of `lines` from `start`, as code, up to about `SLICE_CHARS`.
function slice(lines: string[], start: number): { code: string; end: number } {
  let end = start;
  let chars = 0;
  while (end < lines.length && (chars < SLICE_CHARS || end === start)) chars += lines[end++].length + 1;
  return { code: lines.slice(start, end).join("\n"), end };
}

/// `code` of the file at `path` as one list of tokens per line. `null` keeps it
/// plain: an unknown language, too much code, a grammar that failed, or
/// `signal` aborted, in which case tokenizing stops at once.
export async function highlight(code: string, path: string, signal?: AbortSignal): Promise<Token[][] | null> {
  const found = language(path);
  if (!found || code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const shiki = await core();
    if (!shiki.getLoadedLanguages().includes(found.id)) await shiki.loadLanguage(found.grammar());
    const lines = code.split("\n");
    const tokens: Token[][] = [];
    let grammarState: GrammarState | undefined;
    for (let start = 0; start < lines.length; ) {
      if (signal?.aborted) return null;
      const next = slice(lines, start);
      const result = shiki.codeToTokens(next.code, {
        lang: found.id,
        theme: THEME,
        grammarState,
        tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
        // No clock: compiling a grammar's regexes on first use counts against
        // it and cuts lines short. The length limit is what bounds a line.
        tokenizeTimeLimit: 0,
      });
      grammarState = result.grammarState;
      for (const line of result.tokens) tokens.push(line.map(({ content, color }) => ({ content, color })));
      start = next.end;
      if (start < lines.length) await new Promise((resolve) => setTimeout(resolve));
    }
    return tokens;
  } catch {
    return null;
  }
}
