import { useEffect, useState } from "react";
import type { Loaded } from "../components/DiffBody";
import { readDiff, type ChangedFile } from "./store";

/// How many of a commit's file diffs are read at once.
const READS_AT_ONCE = 4;

/// Every file's diff in commit `sha`, read in list order a few at a time, so
/// the first files show while a large commit is still being read.
export function useCommitDiffs(checkout: string, sha: string, files: ChangedFile[]): Map<string, Loaded> {
  const [diffs, setDiffs] = useState<Map<string, Loaded>>(new Map());
  useEffect(() => {
    let live = true;
    let next = 0;
    setDiffs(new Map());
    const worker = async () => {
      while (live && next < files.length) {
        const file = files[next++];
        let loaded: Loaded;
        try {
          loaded = { phase: "ready", diff: await readDiff(checkout, file, sha) };
        } catch (error) {
          loaded = { phase: "failed", error: String(error) };
        }
        if (live) setDiffs((prev) => new Map(prev).set(file.path, loaded));
      }
    };
    for (let i = 0; i < READS_AT_ONCE; i++) void worker();
    return () => {
      live = false;
    };
  }, [checkout, sha, files]);
  return diffs;
}
