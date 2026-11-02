// Keeps each workspace's fixed root and asks Git for the queue's folder of every
// folder in use. Each folder is asked once a launch: one that is gone has no
// answer to wait for, and one in `homes` is already settled. Saved homes are
// checked at launch and again whenever a new folder turns up, which is how a
// rename shows: a repo can be renamed between launches or under an open window.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot, Workspace } from "../protocol";
import { readHomes } from "./queue";
import { homelessFolders, isOpenSplit, loadRoots, nextRoots, queueFolder, queueMoves, type Roots, saveRoots, withHomes, withoutGone, withSplit, workspaceRoot } from "./workspaceRoot";

export function useRoots(
  snapshot: Snapshot | null,
  local: boolean,
): {
  roots: Roots;
  /// A workspace's fixed root; null before it has one, and on a remote host,
  /// whose workspaces are never given one.
  rootOf: (workspace: Workspace) => string | null;
  queueFolderOf: (workspace: Workspace) => string | null;
  /// The queues whose folder is gone, as `[from, to]`.
  moves: [string, string][];
  /// Whether a workspace split off a tab is still open.
  isOpenSplitOf: (workspaceId: string) => boolean;
  /// Notes a workspace just split off a tab that was in `folder`.
  markSplit: (workspaceId: string, folder: string) => void;
} {
  const [roots, setRoots] = useState(loadRoots);
  const asked = useRef(new Set<string>());
  const checkedHomes = useRef(false);

  useEffect(() => {
    if (!local || !snapshot || checkedHomes.current) return;
    checkedHomes.current = true;
    const saved = [...new Set(Object.values(roots.homes))];
    readHomes(saved)
      .then((answers) => {
        const gone = new Set(saved.filter((_, i) => !answers[i]));
        setRoots((current) => {
          const next = withoutGone(current, gone);
          if (next !== current) saveRoots(next);
          return next;
        });
      })
      .catch(() => {
        checkedHomes.current = false;
      });
  }, [local, snapshot, roots]);

  useEffect(() => {
    if (!local || !snapshot) return;
    const next = nextRoots(roots, snapshot);
    if (next !== roots) {
      setRoots(next);
      saveRoots(next);
      return;
    }
    const folders = homelessFolders(roots, snapshot).filter((folder) => !asked.current.has(folder));
    if (!folders.length) return;
    for (const folder of folders) asked.current.add(folder);
    checkedHomes.current = false;
    readHomes(folders)
      .then((homes) => {
        const found = new Map<string, string>();
        folders.forEach((folder, i) => {
          const home = homes[i];
          if (home) found.set(folder, home);
        });
        setRoots((current) => {
          const next = withHomes(current, found);
          if (next !== current) saveRoots(next);
          return next;
        });
      })
      .catch(() => {
        for (const folder of folders) asked.current.delete(folder);
      });
  }, [local, snapshot, roots]);

  const rootOf = useCallback(
    (workspace: Workspace) => (local && snapshot ? workspaceRoot(roots, workspace, snapshot) : null),
    [local, roots, snapshot],
  );
  const queueFolderOf = useCallback(
    (workspace: Workspace) => (snapshot ? queueFolder(roots, workspace, snapshot) : null),
    [roots, snapshot],
  );
  const moves = useMemo(() => (local && snapshot ? queueMoves(roots, snapshot) : []), [local, roots, snapshot]);
  const isOpenSplitOf = useCallback(
    (workspaceId: string) => !!snapshot && isOpenSplit(roots, workspaceId, snapshot),
    [roots, snapshot],
  );
  const markSplit = useCallback((workspaceId: string, folder: string) => {
    setRoots((current) => {
      const next = withSplit(current, workspaceId, folder);
      saveRoots(next);
      return next;
    });
  }, []);
  return { roots, rootOf, queueFolderOf, moves, isOpenSplitOf, markSplit };
}
