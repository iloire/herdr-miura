// The file view's Markdown preview. File content is untrusted: markdown-it
// runs with `html: false`, so raw HTML in the file is shown as text, and its
// own link check refuses `javascript:` and the like. The CSP blocks scripts
// besides. Links and relative images point into the checkout, which the
// webview cannot load, so they are marked here and `FileView` follows them.

import MarkdownIt from "markdown-it";

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/// GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes.
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export type Target =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; id: string | null };

/// Where a link in the file at `from` leads: a web page, a heading in this
/// file, or another file of the checkout (relative to `from`'s folder, or
/// to the checkout's root when it starts with `/`). Null for a link that
/// leaves the checkout or that the view cannot follow (`mailto:` and such).
export function resolveLink(from: string, href: string): Target | null {
  if (/^https?:\/\//i.test(href)) return { kind: "external", url: href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [rawPath, rawId] = href.split("#", 2) as [string, string | undefined];
  const id = rawId ? decodeURIComponent(rawId) : null;
  const pathPart = rawPath.split("?")[0];
  if (!pathPart) return id ? { kind: "anchor", id } : null;
  const base = pathPart.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const parts = [...base];
  for (const part of decodeURIComponent(pathPart).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? { kind: "file", path: parts.join("/"), id } : null;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Headings get GitHub's ids, so `#section` links land; a repeated one gains `-1`, `-2`.
md.core.ruler.push("heading_ids", (state) => {
  const seen = new Map<string, number>();
  state.tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const base = slug(state.tokens[i + 1]?.children?.map((child) => child.content).join("") ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    token.attrSet("id", count ? `${base}-${count}` : base);
  });
});

// An image inside the checkout is read through `read_file` once the page is
// drawn: its path moves to `data-path` so the webview does not try to fetch it.
// The CSP keeps web images out, so one of those (a README's badge) shows its alt text.
const image = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const target = resolveLink((env as { from: string }).from, String(token.attrGet("src") ?? ""));
  if (target?.kind === "file") {
    token.attrSet("data-path", target.path);
    token.attrSet("src", "");
  } else if (target?.kind === "external") {
    return `<span class="markdown-alt">${md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env))}</span>`;
  }
  return image(tokens, idx, options, env, self);
};

/// The file's frontmatter, if any, as a code block, then its body.
export function renderMarkdown(text: string, from: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const source = front ? "```yaml\n" + front[1] + "\n```\n\n" + text.slice(front[0].length) : text;
  return md.render(source, { from });
}
