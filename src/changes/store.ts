import { invoke } from "@tauri-apps/api/core";

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
  ahead: number;
  behind: number;
  unmerged: [string, number] | null;
  files: ChangedFile[];
  total_files: number;
  added: number;
  removed: number;
  commits: RecentCommit[];
}

/// The files one commit changed, against its first parent.
export interface CommitFiles {
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

/// A file's uncommitted change, or with `commit`, its change in that commit.
export function fileDiff(checkout: string, file: ChangedFile, commit: string | null): Promise<FileDiff> {
  return invoke<FileDiff>("file_diff", { checkout, path: file.path, untracked: file.mark === "?", commit });
}
