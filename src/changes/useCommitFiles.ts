import { useEffect, useState } from "react";
import { RecentReads } from "./commit";
import { commitFiles, type CommitFiles } from "./store";

export type CommitFilesState =
  | { phase: "loading" }
  | ({ phase: "ready" } & CommitFiles)
  | { phase: "failed"; error: string };

/// A commit never changes, so one read serves until it falls out of this.
const reads = new RecentReads<CommitFiles>(100);

/// How long a commit must stay picked before it is read, so holding an arrow
/// key down the list starts no Git for the commits it passes.
const READ_DELAY_MS = 120;

const LOADING: CommitFilesState = { phase: "loading" };

/// The message and files of commit `sha` in `checkout`.
export function useCommitFiles(checkout: string | null, sha: string | null): CommitFilesState | null {
  const key = checkout && sha ? `${checkout}\0${sha}` : null;
  const [settled, setSettled] = useState<{ key: string; state: CommitFilesState } | null>(null);
  useEffect(() => {
    if (!checkout || !sha || !key || reads.get(key)) return;
    let current = true;
    const timer = setTimeout(() => {
      commitFiles(checkout, sha)
        .then((read) => {
          reads.set(key, read);
          if (current) setSettled({ key, state: { phase: "ready", ...read } });
        })
        .catch((error) => current && setSettled({ key, state: { phase: "failed", error: String(error) } }));
    }, READ_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [checkout, sha, key]);
  if (!key) return null;
  const read = reads.get(key);
  if (read) return { phase: "ready", ...read };
  // What settled may be the commit before, for a render.
  return settled?.key === key ? settled.state : LOADING;
}
