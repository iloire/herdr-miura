/// Commits to push; nothing at zero.
export function GitAhead({ count }: { count: number }) {
  return count > 0 ? <span className="git-ahead" title={`${count} to push`}>↑{count}</span> : null;
}

/// Commits to pull; nothing at zero.
export function GitBehind({ count }: { count: number }) {
  return count > 0 ? <span className="git-behind" title={`${count} to pull`}>↓{count}</span> : null;
}

/// Files with uncommitted changes; nothing at zero.
export function GitChanged({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="git-changed" title={`${count} changed ${count === 1 ? "file" : "files"}`}>±{count}</span>;
}
