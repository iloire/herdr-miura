import { useEffect, useState } from "react";
import { movingCommits, type Direction, type RecentCommit } from "./store";

export type MovingState =
  | { phase: "loading" }
  | { phase: "ready"; direction: Direction; commits: RecentCommit[] }
  | { phase: "failed"; error: string };

/// The commits a push or a pull would move. `version` changes when they might
/// have; the last list stays up while the new one is read.
export function useMovingCommits(checkout: string, direction: Direction | null, version: string): MovingState | null {
  const [state, setState] = useState<MovingState | null>(null);
  useEffect(() => {
    if (!direction) {
      setState(null);
      return;
    }
    let current = true;
    setState((last) => (last?.phase === "ready" && last.direction === direction ? last : { phase: "loading" }));
    movingCommits(checkout, direction)
      .then((commits) => current && setState({ phase: "ready", direction, commits }))
      .catch((error) => current && setState({ phase: "failed", error: String(error) }));
    return () => {
      current = false;
    };
  }, [checkout, direction, version]);
  return state;
}
