// Keeps the tab strip still under the pointer. A tab jumps ahead when its agent
// starts working, and a × aimed at one tab could land on another that moved
// there a moment before. So the strip keeps the working set it had when the
// pointer came in until the pointer has left, and a click just after a move
// is ignored, for the move that came while the pointer was on its way.
// New and closed tabs, and pins, still show at once.

import { useEffect, useRef, useState } from "react";
import type { Tab } from "../protocol";

/// How long the pointer may be off the strip before it can move again.
const RELEASE_MS = 300;
/// How long after a move a close is taken to have been aimed at the old order.
const SETTLE_MS = 500;

export interface SteadyStrip {
  /// The tabs to show as working.
  working: ReadonlySet<string>;
  hold: () => void;
  release: () => void;
  /// Whether the strip has been still long enough to trust a click on it.
  settled: () => boolean;
}

export function useSteadyStrip(tabs: readonly Tab[], workspaceId: string | null): SteadyStrip {
  const live = new Set(tabs.filter((tab) => tab.agent_status === "working").map((tab) => tab.tab_id));
  const [held, setHeld] = useState<ReadonlySet<string> | null>(null);
  const working = held ?? live;

  const movedAt = useRef(0);
  const shown = tabs
    .filter((tab) => tab.workspace_id === workspaceId && working.has(tab.tab_id))
    .map((tab) => tab.tab_id)
    .join();
  useEffect(() => {
    // While held this only changes because a tab closed, and nothing moved.
    if (!held) movedAt.current = Date.now();
  }, [shown]);

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const hold = () => {
    window.clearTimeout(timer.current);
    setHeld((current) => current ?? live);
  };
  const release = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHeld(null), RELEASE_MS);
  };
  const settled = () => Date.now() - movedAt.current >= SETTLE_MS;

  return { working, hold, release, settled };
}
