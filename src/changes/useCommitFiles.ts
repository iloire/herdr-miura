import { useEffect, useState } from "react";
import { commitFiles, type CommitFiles } from "./store";

export type CommitFilesState =
  | { phase: "loading" }
  | ({ phase: "ready" } & CommitFiles)
  | { phase: "failed"; error: string };

/// The files of commit `sha` in `checkout`, read once: a commit never changes.
export function useCommitFiles(checkout: string | null, sha: string | null): CommitFilesState | null {
  const [state, setState] = useState<CommitFilesState | null>(null);
  useEffect(() => {
    if (!checkout || !sha) {
      setState(null);
      return;
    }
    let current = true;
    setState({ phase: "loading" });
    commitFiles(checkout, sha)
      .then((read) => current && setState({ phase: "ready", ...read }))
      .catch((error) => current && setState({ phase: "failed", error: String(error) }));
    return () => {
      current = false;
    };
  }, [checkout, sha]);
  return state;
}
