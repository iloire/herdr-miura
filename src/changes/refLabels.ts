import type { CommitRef } from "./store";

/// Labels on a row before the rest become a count, so the subject still shows.
export const MAX_REF_LABELS = 2;

export interface RefLabel {
  kind: CommitRef["kind"];
  name: string;
  current: boolean;
  /// Remotes whose branch of the same name is on this commit too.
  remotes: string[];
}

const ORDER: CommitRef["kind"][] = ["head", "branch", "remote", "tag"];

/// `origin/main` splits at its first slash, so a remote with a slash in its
/// name keeps a label of its own, which is still correct.
function splitRemote(name: string): [string, string] {
  const slash = name.indexOf("/");
  return [name.slice(0, slash), name.slice(slash + 1)];
}

/// One label per name, the current branch first, folding each remote branch
/// into the local branch it matches.
export function refLabels(refs: CommitRef[]): RefLabel[] {
  const locals = new Set(refs.filter((ref) => ref.kind === "branch").map((ref) => ref.name));
  const remotes = new Map<string, string[]>();
  const labels: RefLabel[] = [];
  for (const ref of refs) {
    if (ref.kind === "remote") {
      const [remote, branch] = splitRemote(ref.name);
      if (locals.has(branch)) {
        remotes.set(branch, [...(remotes.get(branch) ?? []), remote]);
        continue;
      }
    }
    labels.push({ kind: ref.kind, name: ref.name, current: ref.current, remotes: [] });
  }
  return labels
    .map((label) => (label.kind === "branch" ? { ...label, remotes: remotes.get(label.name) ?? [] } : label))
    .sort((a, b) => Number(b.current) - Number(a.current) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
