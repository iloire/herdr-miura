// Landing a worktree from the sidebar. `land.rs` does the work and refuses
// what it can see in the repo; what it cannot see is agents, which only the
// snapshot knows, so they are decided here: when the action is offered, what
// refuses, and how one land moves through its phases.

import { Channel, invoke } from "@tauri-apps/api/core";
import { busy } from "../app/queue";
import { inside } from "../app/worktreeGroups";
import type { Snapshot } from "../protocol";
import type { Worktree } from "./worktrees";

export type LandStep = "start" | "check" | "rebase" | "fast_forward" | "remove" | "delete_branch" | "confirm";

/// `land_plan`'s answer when the worktree can land: what the confirmation names.
export interface LandPlan {
  branch: string;
  head: string;
  main: string;
  commits: number;
  /// The command that will run; `null` when the repo has no check.
  check: string | null;
}

type PlanAnswer = ({ kind: "ready" } & LandPlan) | { kind: "refused"; message: string };

export type LandFailure = {
  kind: "failed";
  step: LandStep;
  message: string;
  /// What state things were left in.
  left: string;
  details: string;
};

export type LandOutcome = { kind: "passed" } | { kind: "landed"; main: string; commits: number } | LandFailure;

/// One land, from the click to the note on the card. `card` is the workspace
/// it was started from: the worktree's row is gone once it lands.
export type Land = { card: string; worktree: Worktree; blocked: Blocked } & (
  | { phase: "reading" }
  | { phase: "asking"; plan: LandPlan }
  | { phase: "running"; plan: LandPlan; step: LandStep }
  | { phase: "ended"; branch: string; outcome: Extract<LandOutcome, { kind: "landed" | "failed" }> }
);

/// Why it may not go on right now, read fresh each time it is asked.
type Blocked = () => string | null;

/// Only a branch with commits main lacks has anything to land. The main
/// checkout is never in `worktrees`, so it never gets here.
export function canLand(worktree: Worktree): boolean {
  return worktree.branch !== null && (worktree.ahead ?? 0) > 0;
}

/// Why an agent stops a land: one at work in the worktree, which may be its
/// own work in progress. An idle or finished agent does not, or nothing could
/// land while its session stays open. Only agents in a Herdr pane are known.
export function agentRefusal(path: string, snapshot: Snapshot | null): string | null {
  if (!snapshot) return "The window cannot see its agents right now.";
  const panes = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
  const agent = snapshot.agents.find((agent) => {
    const pane = panes.get(agent.pane_id);
    return busy(agent) && [pane?.cwd, pane?.foreground_cwd].some((folder) => folder && inside(folder, path));
  });
  if (!agent) return null;
  return `${agent.display_agent ?? agent.name ?? "An agent"} is working in this worktree.`;
}

/// Whether a repo's land is under way, so nothing else may start there.
export function landing(land: Land | undefined): boolean {
  return land !== undefined && land.phase !== "ended";
}

const refused = (message: string): LandFailure => ({
  kind: "failed",
  step: "start",
  message,
  left: "Nothing changed.",
  details: "",
});

const short = (sha: string) => sha.slice(0, 7);

/// Runs one land per repo and remembers how each went. The backend holds the
/// real lock; this is what keeps the card from asking.
export class LandStore {
  private state: ReadonlyMap<string, Land> = new Map();
  private listeners = new Set<() => void>();

  /// `onSettled` runs once a land has ended, to reread the worktrees.
  constructor(private onSettled: () => void) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(repo: string, land: Land | null): void {
    const next = new Map(this.state);
    if (land) next.set(repo, land);
    else next.delete(repo);
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private end(repo: string, land: Land, branch: string, outcome: Extract<Land, { phase: "ended" }>["outcome"]): void {
    this.set(repo, { card: land.card, worktree: land.worktree, blocked: land.blocked, phase: "ended", branch, outcome });
    this.onSettled();
  }

  /// The Land button: reads the plan and opens the confirmation, or leaves a
  /// refusal on the card if asking would be pointless.
  async ask(card: string, worktree: Worktree, blocked: Blocked): Promise<void> {
    const repo = worktree.repo;
    if (landing(this.state.get(repo))) return;
    const land: Land = { card, worktree, blocked, phase: "reading" };
    this.set(repo, land);
    const branch = worktree.branch ?? "";
    const refusal = blocked();
    if (refusal) return this.end(repo, land, branch, refused(refusal));
    let plan: PlanAnswer;
    try {
      plan = await invoke<PlanAnswer>("land_plan", { worktree: worktree.path });
    } catch (error) {
      plan = { kind: "refused", message: String(error) };
    }
    if (plan.kind === "refused") return this.end(repo, land, branch, refused(plan.message));
    this.set(repo, { ...land, phase: "asking", plan });
  }

  cancel(repo: string): void {
    if (this.state.get(repo)?.phase === "asking") this.set(repo, null);
  }

  /// Confirmed: the check, then the agents again, since it can take minutes,
  /// and only then the steps that write.
  async confirm(repo: string): Promise<void> {
    const land = this.state.get(repo);
    if (land?.phase !== "asking") return;
    const { plan, worktree, blocked } = land;
    const refusal = blocked();
    if (refusal) return this.end(repo, land, plan.branch, refused(refusal));
    const target = { worktree: worktree.path, branch: plan.branch, head: plan.head, check: plan.check };
    // A step can arrive after the answer that ended the land: a Channel keeps
    // its own order, not the invoke's.
    const step = (step: LandStep) => {
      if (this.state.get(repo)?.phase !== "ended") this.set(repo, { ...land, phase: "running", plan, step });
    };
    let outcome: LandOutcome;
    try {
      step("check");
      outcome = await invoke<LandOutcome>("land_check", { target });
      if (outcome.kind === "passed") {
        const late = blocked();
        if (late) {
          outcome = {
            kind: "failed",
            step: "check",
            message: `${late} It started during the check, so the land stopped.`,
            left: `${plan.branch} is as it was, at ${short(plan.head)}. ${plan.main} did not move.`,
            details: "",
          };
        } else {
          const steps = new Channel<LandStep>();
          steps.onmessage = step;
          outcome = await invoke<LandOutcome>("land_finish", { target, steps });
        }
      }
    } catch (error) {
      outcome = {
        kind: "failed",
        step: "start",
        message: String(error),
        left: "The app lost track of it, so look at the worktree and main before trying again.",
        details: "",
      };
    }
    // `passed` is only ever followed by more steps.
    if (outcome.kind !== "passed") this.end(repo, land, plan.branch, outcome);
  }

  dismiss(repo: string): void {
    if (this.state.get(repo)?.phase === "ended") this.set(repo, null);
  }
}
