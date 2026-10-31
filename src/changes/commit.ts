import type { RecentCommit } from "./store";

/// A commit message as a title and a body, either of which a reader can skim.
export interface CommitMessage {
  title: string;
  body: string;
}

const TYPED_SUBJECT = /^(feat|fix|docs|refactor|chore|test|perf|style|build|ci|revert)(\([^)]*\))?!?: /;

/// Splits a message at its first line. A subject in the old
/// `type: what - details` form also gives up its details to the body, and a
/// subject without the type keeps its ` - `, which is then just punctuation.
export function splitMessage(message: string): CommitMessage {
  const [subject, ...rest] = message.trim().split("\n");
  const body = rest.join("\n").trim();
  const cut = subject.indexOf(" - ");
  if (cut < 0 || !TYPED_SUBJECT.test(subject)) return { title: subject, body };
  const details = subject.slice(cut + 3).trim();
  return { title: subject.slice(0, cut), body: [details, body].filter(Boolean).join("\n\n") };
}

/// The commit `by` rows from `sha`, or null past either end or off the list.
export function commitBeside(commits: RecentCommit[], sha: string, by: number): RecentCommit | null {
  const index = commits.findIndex((commit) => commit.sha === sha);
  return index < 0 ? null : (commits[index + by] ?? null);
}

/// The last `capacity` things read, for what never changes, like a commit.
export class RecentReads<T> {
  private entries = new Map<string, T>();

  constructor(private capacity: number) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}
