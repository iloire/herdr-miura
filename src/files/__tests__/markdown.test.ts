import { describe, expect, it } from "vitest";
import { isMarkdown, renderMarkdown, resolveLink, slug } from "../markdown";

describe("resolveLink", () => {
  it("follows a relative link from the file's folder", () => {
    expect(resolveLink("docs/architecture.md", "plan-changes.md")).toEqual({
      kind: "file",
      path: "docs/plan-changes.md",
      id: null,
    });
    expect(resolveLink("docs/a.md", "../README.md#run-it")).toEqual({ kind: "file", path: "README.md", id: "run-it" });
    expect(resolveLink("docs/a.md", "/src/App.tsx")).toEqual({ kind: "file", path: "src/App.tsx", id: null });
    expect(resolveLink("README.md", "./docs/my%20notes.md")).toEqual({
      kind: "file",
      path: "docs/my notes.md",
      id: null,
    });
  });

  it("keeps a link from leaving the checkout", () => {
    expect(resolveLink("README.md", "../secret")).toBeNull();
    expect(resolveLink("docs/a.md", "../../etc/passwd")).toBeNull();
  });

  it("tells web pages, anchors and other schemes apart", () => {
    expect(resolveLink("README.md", "https://example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(resolveLink("README.md", "#usage")).toEqual({ kind: "anchor", id: "usage" });
    expect(resolveLink("README.md", "mailto:a@b.c")).toBeNull();
    expect(resolveLink("README.md", "javascript:alert(1)")).toBeNull();
    expect(resolveLink("README.md", "//evil.example")).toBeNull();
  });
});

describe("renderMarkdown", () => {
  it("shows raw HTML as text", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">', "README.md");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("drops javascript: links", () => {
    expect(renderMarkdown("[x](javascript:alert(1))", "README.md")).not.toContain("href");
  });

  it("gives headings GitHub's ids", () => {
    const html = renderMarkdown("# Run it, now!\n\n## Notes\n\n## Notes", "README.md");
    expect(html).toContain('<h1 id="run-it-now">');
    expect(html).toContain('<h2 id="notes">');
    expect(html).toContain('<h2 id="notes-1">');
  });

  it("marks a checkout image to be read, and shows a web one's alt text", () => {
    const html = renderMarkdown("![shot](screenshots/app.png) ![<b>CI</b>](https://x.io/b.svg)", "docs/a.md");
    expect(html).toContain('src="" alt="shot" data-path="docs/screenshots/app.png"');
    expect(html).toContain('<span class="markdown-alt">&lt;b&gt;CI&lt;/b&gt;</span>');
    expect(html).not.toContain("x.io");
  });

  it("shows frontmatter as a code block", () => {
    const html = renderMarkdown("---\nname: lead\n---\n# Lead", "a.md");
    expect(html).toContain('<pre><code class="language-yaml">name: lead\n</code></pre>');
    expect(html).toContain('<h1 id="lead">Lead</h1>');
  });
});

it("recognises Markdown files", () => {
  expect(isMarkdown("docs/README.md")).toBe(true);
  expect(isMarkdown("NOTES.Markdown")).toBe(true);
  expect(isMarkdown("src/md.ts")).toBe(false);
  expect(slug("Tests, CI and the README badge")).toBe("tests-ci-and-the-readme-badge");
});
