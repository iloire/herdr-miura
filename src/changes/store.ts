import { invoke } from "@tauri-apps/api/core";
import { addedFile, parseUnified, type ParsedDiff } from "./diff";

export interface ChangedFile {
  path: string;
  /// `git status --short`'s letter: A, U, D, M, R, or ?.
  mark: string;
  additions: number | null;
  deletions: number | null;
}

export interface RecentCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  /// Seconds since the Unix epoch.
  time: number;
}

export interface CheckoutChanges {
  path: string;
  branch: string | null;
  upstream: string | null;
  /// The upstream's ref is gone, deleted on the remote and pruned here.
  upstream_gone: boolean;
  ahead: number;
  behind: number;
  /// HEAD has a commit.
  born: boolean;
  operation: "rebase" | "merge" | "cherry-pick" | null;
  /// A rebase's step and its steps in all.
  operation_step: [number, number] | null;
  /// Files with unresolved conflicts, all of them though `files` stops short.
  conflicts: number;
  remotes: string[];
  unmerged: [string, number] | null;
  files: ChangedFile[];
  total_files: number;
  added: number;
  removed: number;
  commits: RecentCommit[];
}

/// One commit's whole message and the files it changed, against its first parent.
export interface CommitFiles {
  message: string;
  files: ChangedFile[];
  total_files: number;
}

export type FileDiff = { type: "patch"; text: string } | { type: "untracked"; text: string };

export type ChangesState =
  | { phase: "idle" }
  | { phase: "loading"; directory: string }
  | { phase: "ready"; directory: string; checkout: CheckoutChanges | null; at: number }
  | { phase: "failed"; directory: string; error: string };

/// Reads the Changes of the checkout a directory is in. One read runs at a
/// time; a request that arrives meanwhile is kept and runs next, so a burst
/// of pane switches costs at most two reads.
export class ChangesStore {
  private state: ChangesState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private running = false;
  private queued: string | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(state: ChangesState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  refresh(directory: string): void {
    if (this.running) {
      this.queued = directory;
      return;
    }
    void this.read(directory);
  }

  /// Reads the directory last asked for again, as after a push or a pull.
  reread(): void {
    if ("directory" in this.state) this.refresh(this.state.directory);
  }

  private async read(directory: string): Promise<void> {
    this.running = true;
    // Keep showing the last result for the same directory while it reloads.
    if (!("directory" in this.state) || this.state.directory !== directory) {
      this.set({ phase: "loading", directory });
    }
    try {
      const checkout = await invoke<CheckoutChanges | null>("checkout_changes", { directory });
      this.set({ phase: "ready", directory, checkout, at: Date.now() });
    } catch (error) {
      this.set({ phase: "failed", directory, error: String(error) });
    } finally {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      if (next) this.refresh(next);
    }
  }
}

export function commitFiles(checkout: string, sha: string): Promise<CommitFiles> {
  return invoke<CommitFiles>("commit_files", { checkout, sha });
}

/// Which way commits would move between a branch and its upstream.
export type Direction = "outgoing" | "incoming";

export function movingCommits(checkout: string, direction: Direction): Promise<RecentCommit[]> {
  return invoke<RecentCommit[]>("moving_commits", { checkout, direction });
}

/// A file's uncommitted change, or with `commit`, its change in that commit.
export function fileDiff(checkout: string, file: ChangedFile, commit: string | null): Promise<FileDiff> {
  return invoke<FileDiff>("file_diff", { checkout, path: file.path, untracked: file.mark === "?", commit });
}

/// `fileDiff`, parsed: an untracked file reads as all added.
export async function readDiff(checkout: string, file: ChangedFile, commit: string | null): Promise<ParsedDiff> {
  const result = await fileDiff(checkout, file, commit);
  return result.type === "untracked" ? addedFile(result.text) : parseUnified(result.text);
}
