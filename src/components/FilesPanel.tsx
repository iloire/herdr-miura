import { useCallback, useEffect, useMemo, useState } from "react";
import type { Controller } from "../app/controller";
import { type ListingState, listFolder } from "../files/listing";
import { ancestors, buildTree, matchingRows, visibleRows } from "../files/tree";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { treeMenu } from "./treeMenu";
import { FileIcon, FolderIcon } from "./icons";

/// Rows drawn at most; a filter that matches more asks for more letters.
const MAX_ROWS = 2000;

/// Every file of the checkout under the focused pane, as folders, with the
/// changed ones marked and a filter on top, as herdr-gpui's Files section.
/// Picking a file opens it over the terminal.
export function FilesPanel({
  controller,
  state,
  changed,
  selected,
  onOpen,
  onLeave,
  showIgnored,
  onToggleIgnored,
}: {
  controller: Controller;
  state: ListingState;
  /// Changed paths and their `git status --short` letter.
  changed: ReadonlyMap<string, string>;
  selected: string | null;
  onOpen: (path: string) => void;
  /// Escape in an empty filter: typing goes back to the terminal.
  onLeave: () => void;
  /// Whether ignored files are listed, dimmed.
  showIgnored: boolean;
  onToggleIgnored: () => void;
}) {
  const listing = state.phase === "ready" ? state.listing : null;
  const root = listing?.root ?? null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  // What the ignored folders opened so far hold, as Git lists none of it.
  const [opened, setOpened] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  // Open folders mean nothing in another checkout.
  useEffect(() => {
    setExpanded(new Set());
    setOpened(new Map());
  }, [root]);

  const changedPaths = useMemo(() => new Set(changed.keys()), [changed]);
  const ignored = useMemo(() => (listing ? [...listing.ignored, ...[...opened.values()].flat()] : []), [listing, opened]);
  // Folders Git ignores whole, whose contents are read on opening one.
  const unread = useMemo(() => new Set(ignored.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1))), [ignored]);
  const tree = useMemo(() => listing && buildTree(listing.files, changedPaths, ignored), [listing, changedPaths, ignored]);
  const filter = query.trim();
  const rows = useMemo(
    () => (!tree ? [] : filter ? matchingRows(tree, filter) : visibleRows(tree, expanded)),
    [tree, filter, expanded],
  );

  const toggle = (path: string) => {
    if (root && unread.has(path) && !opened.has(path) && !expanded.has(path)) {
      listFolder(root, path)
        .then((entries) => setOpened((last) => new Map(last).set(path, entries)))
        .catch(() => setOpened((last) => new Map(last).set(path, [])));
    }
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  // A file opened from a filtered list stays visible once the filter clears.
  const open = (path: string) => {
    setExpanded((open) => new Set([...open, ...ancestors(path)]));
    onOpen(path);
  };

  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const name = root?.split("/").pop() ?? "Files";
  return (
    <aside className="changes files" aria-label="Files">
      <header className="changes-head">
        <span title={root ?? undefined}>{name}</span>
        <button
          className="files-ignored"
          aria-pressed={showIgnored}
          title={showIgnored ? "Hide the files Git ignores" : "Show the files Git ignores, such as .env.local"}
          onClick={onToggleIgnored}
        >
          Ignored
        </button>
      </header>
      <div className="files-filter">
        <input
          type="search"
          placeholder="Filter files"
          aria-label="Filter files"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const first = rows.find((row) => !row.node.children);
              if (first) open(first.node.path);
            } else if (event.key === "Escape") {
              if (query) setQuery("");
              else onLeave();
            } else return;
            event.preventDefault();
          }}
        />
      </div>
      {state.phase === "idle" && <p className="empty">Focus a pane to see its checkout.</p>}
      {state.phase === "loading" && <p className="empty">Listing the files…</p>}
      {state.phase === "failed" && <p className="empty error">Could not list the files: {state.error}</p>}
      {state.phase === "ready" && !listing && <p className="empty">This folder is not in a Git checkout.</p>}
      {filter && tree && rows.length === 0 && <p className="empty">No file names hold “{filter}”.</p>}
      <ul className="file-tree">
        {rows.slice(0, MAX_ROWS).map(({ node, depth }) => {
          const folder = node.children !== null;
          const mark = changed.get(node.path);
          return (
            <li key={node.path}>
              <button
                className="tree-row"
                style={{ paddingLeft: 8 + depth * 14 }}
                aria-expanded={folder ? filter !== "" || expanded.has(node.path) : undefined}
                aria-current={!folder && node.path === selected ? "true" : undefined}
                title={node.path}
                onClick={() => (folder ? !filter && toggle(node.path) : open(node.path))}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (!root) return;
                  const items = treeMenu(controller, root, node.path, {
                    folder,
                    expanded: folder && expanded.has(node.path),
                    onOpen: () => open(node.path),
                    onToggle: filter ? undefined : () => toggle(node.path),
                  });
                  setMenu({ x: event.clientX, y: event.clientY, items });
                }}
              >
                <span className="chevron">{folder ? "›" : ""}</span>
                {folder ? <FolderIcon /> : <FileIcon />}
                <span className={`tree-name ${node.changed ? "changed" : ""} ${node.ignored ? "ignored" : ""}`}>{node.name}</span>
                {mark && <span className={`mark mark-${mark === "?" ? "untracked" : mark}`}>{mark}</span>}
                {folder && node.changed > 0 && (
                  <span className="tree-count" title={`${node.changed} changed`}>
                    {node.changed}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > MAX_ROWS && <p className="empty">and {rows.length - MAX_ROWS} more; type to narrow them.</p>}
      {listing && listing.total_files > listing.files.length && (
        <p className="empty">Only the first {listing.files.length} of {listing.total_files} files are listed.</p>
      )}
      {menu && <ContextMenu menu={menu} onClose={closeMenu} />}
    </aside>
  );
}
