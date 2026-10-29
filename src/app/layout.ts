// How the window was laid out when it last closed: the sidebar shown or not,
// which panel the right-hand drawer held, and the file picked in it. Kept in
// this window's storage, so a relaunch opens where you left off.

export type Drawer = "changes" | "files" | "queue";

/// A file picked in a panel, with the checkout it belongs to: in another
/// checkout the same path means nothing.
export interface SavedFile {
  root: string;
  path: string;
}

export interface Layout {
  sidebar: boolean;
  drawer: Drawer | null;
  /// The changed file whose diff was open in the Changes panel.
  changesFile: SavedFile | null;
  /// The file open from the Files panel's tree.
  treeFile: SavedFile | null;
}

export const DEFAULT_LAYOUT: Layout = { sidebar: true, drawer: null, changesFile: null, treeFile: null };

const KEY = "layout";

function savedFile(value: unknown): SavedFile | null {
  if (typeof value !== "object" || value === null) return null;
  const { root, path } = value as Record<string, unknown>;
  return typeof root === "string" && typeof path === "string" ? { root, path } : null;
}

/// The saved layout, each part that is missing or unusable at its default.
/// Storage can be missing or throw, and the window must still draw.
export function loadLayout(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Layout {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    if (typeof saved !== "object" || saved === null) return DEFAULT_LAYOUT;
    const { sidebar, drawer, changesFile, treeFile } = saved as Record<string, unknown>;
    return {
      sidebar: typeof sidebar === "boolean" ? sidebar : DEFAULT_LAYOUT.sidebar,
      drawer: drawer === "changes" || drawer === "files" || drawer === "queue" ? drawer : null,
      changesFile: savedFile(changesFile),
      treeFile: savedFile(treeFile),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/// Saves `patch` over what is stored, so the controller and the view can
/// each keep their own part.
export function saveLayout(
  patch: Partial<Layout>,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ ...loadLayout(storage), ...patch }));
  } catch {
    // A layout that is not remembered is only a convenience lost.
  }
}
