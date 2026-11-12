import { invoke } from "@tauri-apps/api/core";
import type { CheckoutChanges } from "./store";

/// Where `origin` lives on the web, as `changes.rs` parses its URL.
export interface WebRepo {
  kind: "github" | "gitlab";
  host: string;
  /// `owner/repo`, or a GitLab project's whole group path.
  path: string;
  /// `https://<host>/<path>`.
  url: string;
}

export interface PullRequest {
  number: number;
  url: string;
  draft: boolean;
  review: "approved" | "changes_requested" | "review_required" | null;
}

export type Checks = "pass" | "fail" | "running";

/// What `forge_status` answers through `gh`.
export interface ForgeStatus {
  pr: PullRequest | null;
  checks: Checks | null;
}

const NAME = { github: "GitHub", gitlab: "GitLab" } as const;

export const forgeName = (repo: WebRepo) => NAME[repo.kind];

/// A branch or file path in a URL: each part encoded, the slashes kept.
const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/// GitLab puts its pages under `/-/`.
const page = (repo: WebRepo, rest: string) => `${repo.url}${repo.kind === "gitlab" ? "/-" : ""}/${rest}`;

export const treeUrl = (repo: WebRepo, branch: string) => page(repo, `tree/${segments(branch)}`);

export const commitUrl = (repo: WebRepo, sha: string) => page(repo, `commit/${sha}`);

export const blobUrl = (repo: WebRepo, branch: string, path: string) =>
  page(repo, `blob/${segments(branch)}/${segments(path)}`);

/// One line of a file at `ref` (a commit or a branch). GitHub and GitLab
/// both mark a line with `#L<n>`.
export const lineUrl = (repo: WebRepo, ref: string, path: string, line: number) =>
  `${blobUrl(repo, ref, path)}#L${line}`;

/// Where a diff's line numbers lead on the web: the commit each side of the
/// diff was read from, or null where that side is not a commit (the working
/// tree) or is not known.
export interface LineLinks {
  repo: WebRepo;
  path: string;
  old: string | null;
  new: string | null;
}

/// The URL for a line number on one side of a diff, or null where that side
/// has no commit to point at.
export function diffLineUrl(links: LineLinks, side: "old" | "new", line: number): string | null {
  const ref = links[side];
  return ref ? lineUrl(links.repo, ref, links.path, line) : null;
}

/// The branch against `base`; `expand` opens GitHub's new pull request form.
export function compareUrl(repo: WebRepo, base: string, branch: string, expand = false): string {
  const range = `${segments(base)}...${segments(branch)}`;
  if (repo.kind === "gitlab") return page(repo, `compare/${range}`);
  return page(repo, `compare/${range}${expand ? "?expand=1" : ""}`);
}

/// The branch's CI runs.
export function actionsUrl(repo: WebRepo, branch: string): string {
  if (repo.kind === "gitlab") return page(repo, `pipelines?ref=${encodeURIComponent(branch)}`);
  return page(repo, `actions?query=${encodeURIComponent(`branch:${branch}`)}`);
}

/// The branch's name on `origin`, when it has been pushed there and is still
/// there. It can differ from the local name.
export function pushedBranch(checkout: CheckoutChanges): string | null {
  const upstream = checkout.upstream;
  if (!upstream || checkout.upstream_gone || !upstream.startsWith("origin/")) return null;
  return upstream.slice("origin/".length);
}

/// The default branch the branch is ahead of, and the pushed name to compare
/// it with, when there is something to compare.
export function comparison(checkout: CheckoutChanges): { base: string; branch: string } | null {
  const branch = pushedBranch(checkout);
  const [base, ahead] = checkout.unmerged ?? ["", 0];
  if (!branch || ahead === 0 || !base.startsWith("origin/")) return null;
  return { base: base.slice("origin/".length), branch };
}

/// A file's page on the pushed branch, where it has one: a new file is not
/// there yet, and a rename's new name neither.
export const onRemote = (mark: string) => mark === "M" || mark === "D" || mark === "U";

export const REVIEW_LABEL: Record<NonNullable<PullRequest["review"]>, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: "review required",
};

export const CHECKS_LABEL: Record<Checks, string> = { pass: "checks passed", fail: "checks failed", running: "checks running" };

/// One `gh` answer per checkout, for the branch and commit it was asked about.
export interface ForgeEntry {
  key: string;
  status: ForgeStatus | null;
  at: number;
}

/// Asked again on focus at most this often; a fetch or push asks at once.
export const FORGE_GAP_MS = 60_000;

/// Whether to ask `gh` again: never two at once, always for a new branch or
/// commit, and otherwise once the gap has passed or when `force`d.
export function forgeDue(entry: ForgeEntry | undefined, key: string, now: number, force: boolean): boolean {
  if (!entry || entry.key !== key) return true;
  return force || now - entry.at >= FORGE_GAP_MS;
}

interface Asked {
  branch: string;
  sha: string;
}

/// GitHub's word on each checkout's branch, read off the panel's own Git
/// reads, since `gh` waits on the network. It is asked when the branch or its
/// head changes, on focus, and after a fetch or push, never on the 5 s poll.
export class ForgeStore {
  private state: ReadonlyMap<string, ForgeEntry> = new Map();
  private listeners = new Set<() => void>();
  private running = new Set<string>();
  private asked = new Map<string, Asked>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  /// Asks about `branch` at `sha` in `checkout`, unless that answer is fresh.
  refresh(checkout: string, branch: string, sha: string, force = false): void {
    this.asked.set(checkout, { branch, sha });
    const key = `${branch}@${sha}`;
    if (this.running.has(checkout) || !forgeDue(this.state.get(checkout), key, Date.now(), force)) return;
    this.running.add(checkout);
    invoke<ForgeStatus | null>("forge_status", { checkout, branch, sha })
      .catch(() => null)
      .then((status) => {
        this.running.delete(checkout);
        this.state = new Map(this.state).set(checkout, { key, status, at: Date.now() });
        for (const listener of this.listeners) listener();
      });
  }

  /// Asks again about whatever was last asked in `checkout`: after a fetch or
  /// push, a pull request or CI run may have appeared.
  stale(checkout: string): void {
    const asked = this.asked.get(checkout);
    if (asked) this.refresh(checkout, asked.branch, asked.sha, true);
  }
}
