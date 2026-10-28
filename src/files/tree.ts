// A checkout's listed files as folders, and the rows its open folders show,
// as herdr-gpui's Files section does. Folders lead their files, and each
// folder counts the changed files under it, so a closed folder still says
// an agent was in there.

export interface TreeNode {
  name: string;
  /// Relative to the checkout with `/` between parts; empty for the root.
  path: string;
  /// `null` for a file.
  children: TreeNode[] | null;
  /// Changed files at or under this node.
  changed: number;
}

/// One shown node and how deep it sits under the checkout.
export interface Row {
  node: TreeNode;
  depth: number;
}

/// The folders `path` sits in, outermost first: `a/b/c` gives `a`, `a/b`.
export function ancestors(path: string): string[] {
  const folders: string[] = [];
  for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
    folders.push(path.slice(0, end));
  }
  return folders;
}

function byFolderThenName(a: TreeNode, b: TreeNode): number {
  if ((a.children === null) !== (b.children === null)) return a.children === null ? 1 : -1;
  const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return lower !== 0 ? lower : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/// The tree of `files`, with `changed` (paths) counted up their folders.
export function buildTree(files: readonly string[], changed: ReadonlySet<string>): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], changed: 0 };
  const folders = new Map<string, TreeNode>([["", root]]);
  const add = (parent: TreeNode, path: string, folder: boolean): TreeNode => {
    const node: TreeNode = { name: path.slice(path.lastIndexOf("/") + 1), path, children: folder ? [] : null, changed: 0 };
    parent.children?.push(node);
    return node;
  };
  for (const file of files) {
    let parent = root;
    for (const folder of ancestors(file)) {
      let node = folders.get(folder);
      if (!node) {
        node = add(parent, folder, true);
        folders.set(folder, node);
      }
      parent = node;
    }
    const node = add(parent, file, false);
    if (changed.has(file)) {
      node.changed = 1;
      root.changed++;
      for (const folder of ancestors(file)) folders.get(folder)!.changed++;
    }
  }
  for (const folder of folders.values()) folder.children!.sort(byFolderThenName);
  return root;
}

/// The rows shown with the folders in `expanded` open, top first.
export function visibleRows(root: TreeNode, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number) => {
    for (const child of node.children ?? []) {
      rows.push({ node: child, depth });
      if (child.children && expanded.has(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/// The files `query` matches and the folders holding them, all open. Matched
/// without case against a file's name, or its whole path once the query holds
/// a `/`.
export function matchingRows(root: TreeNode, query: string): Row[] {
  const needle = query.toLowerCase();
  const byPath = needle.includes("/");
  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number): boolean => {
    const start = rows.length;
    for (const child of node.children ?? []) {
      if (child.children) {
        rows.push({ node: child, depth });
        if (!walk(child, depth + 1)) rows.pop();
      } else if ((byPath ? child.path : child.name).toLowerCase().includes(needle)) {
        rows.push({ node: child, depth });
      }
    }
    return rows.length > start;
  };
  walk(root, 0);
  return rows;
}
