import { useEffect, useState } from "react";
import type { Loaded } from "../components/DiffBody";
import { RecentReads } from "./commit";
import { readDiff, type ChangedFile } from "./store";

/// How many of a commit's file diffs are read at once.
const READS_AT_ONCE = 4;

/// Commits whose diffs are kept, so stepping back to one is immediate, and the
/// most files one may have: a far larger commit is not worth the memory.
const KEPT_COMMITS = 20;
const MOST_KEPT_FILES = 40;

const reads = new RecentReads<Map<string, Loaded>>(KEPT_COMMITS);
const NO_DIFFS = new Map<string, Loaded>();

/// Every file's diff in commit `sha`, read in list order a few at a time, so
/// the first files show while a large commit is still being read.
export function useCommitDiffs(checkout: string, sha: string, files: ChangedFile[]): Map<string, Loaded> {
  const key = `${checkout}\0${sha}`;
  const [reading, setReading] = useState<{ key: string; diffs: Map<string, Loaded> } | null>(null);
  useEffect(() => {
    if (reads.get(key)) return;
    let live = true;
    let next = 0;
    let left = files.length;
    let diffs = new Map<string, Loaded>();
    setReading({ key, diffs });
    const worker = async () => {
      while (live && next < files.length) {
        const file = files[next++];
        let loaded: Loaded;
        try {
          loaded = { phase: "ready", diff: await readDiff(checkout, file, sha) };
        } catch (error) {
          loaded = { phase: "failed", error: String(error) };
        }
        if (!live) return;
        diffs = new Map(diffs).set(file.path, loaded);
        setReading({ key, diffs });
        left -= 1;
        const whole = [...diffs.values()].every((diff) => diff.phase === "ready");
        if (left === 0 && whole && files.length <= MOST_KEPT_FILES) reads.set(key, diffs);
      }
    };
    for (let i = 0; i < READS_AT_ONCE; i++) void worker();
    return () => {
      live = false;
    };
  }, [checkout, sha, key, files]);
  return reads.get(key) ?? (reading?.key === key ? reading.diffs : NO_DIFFS);
}
