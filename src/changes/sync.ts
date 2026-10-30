import { invoke } from "@tauri-apps/api/core";
import type { CheckoutChanges } from "./store";

export type SyncOp = "fetch" | "push" | "publish" | "pull";

/// What `sync_checkout` answers: a refusal is an answer, not an error.
export type SyncOutcome =
  | { kind: "done" }
  | { kind: "failed"; reason: "rejected" | "diverged" | "busy" | "other"; message: string; details: string };

/// The last push, publish or pull in a checkout, shown until the next one or
/// until dismissed. A fetch never lands here: it fails quietly.
export interface SyncNote {
  op: SyncOp;
  outcome: SyncOutcome;
  /// Milliseconds since the Unix epoch.
  at: number;
}

export interface CheckoutSync {
  running: SyncOp | null;
  /// The last fetch that worked, in milliseconds since the Unix epoch.
  fetchedAt: number | null;
  /// Why the last fetch failed; cleared by one that works.
  fetchError: string | null;
  /// The last fetch started, whatever became of it.
  triedAt: number | null;
  note: SyncNote | null;
}

export const IDLE: CheckoutSync = { running: null, fetchedAt: null, fetchError: null, triedAt: null, note: null };

/// What the panel offers for a checkout, decided from one read of it.
export interface SyncOffer {
  /// Push, Pull and the commit lists: the branch tracks something real.
  tracked: boolean;
  publish: boolean;
  /// Why neither is offered, when that is not obvious.
  note: string | null;
}

export function syncOffer(checkout: CheckoutChanges): SyncOffer {
  const none = { tracked: false, publish: false };
  if (checkout.remotes.length === 0 || !checkout.branch) return { ...none, note: null };
  if (checkout.operation) return { ...none, note: `A ${checkout.operation} is in progress.` };
  if (!checkout.born) return { ...none, note: null };
  if (checkout.upstream_gone) return { ...none, note: `Its upstream ${checkout.upstream} is gone from the remote.` };
  if (checkout.upstream) {
    const diverged = checkout.ahead > 0 && checkout.behind > 0;
    return {
      tracked: true,
      publish: false,
      note: diverged ? `Diverged from ${checkout.upstream}: a pull will be refused until you merge or rebase.` : null,
    };
  }
  return { tracked: false, publish: checkout.remotes.includes("origin"), note: null };
}

/// The last push was turned away for commits on the remote, so its note offers a Pull.
export function pullAfterRejection(note: SyncNote | null): boolean {
  return note?.outcome.kind === "failed" && note.outcome.reason === "rejected";
}

/// The one action on the sync line that is the panel's main action. None while
/// a note offers its own Pull, and Pull before Push: a diverged checkout shows
/// both, and a push would only be turned away.
export function mainSyncOp(checkout: CheckoutChanges, note: SyncNote | null): SyncOp | null {
  if (pullAfterRejection(note)) return null;
  if (checkout.behind > 0) return "pull";
  return checkout.upstream ? "push" : "publish";
}

/// A checkout is fetched at most this often, however often the window comes
/// back to the front.
export const FETCH_GAP_MS = 60_000;

export function fetchDue(sync: CheckoutSync, now: number): boolean {
  return !sync.running && (sync.triedAt === null || now - sync.triedAt >= FETCH_GAP_MS);
}

/// `sync` once `op` has ended. A fetch only moves the fetch facts, and one
/// turned away because something else was running says nothing at all.
export function settled(sync: CheckoutSync, op: SyncOp, outcome: SyncOutcome, now: number): CheckoutSync {
  const idle = { ...sync, running: null };
  if (op !== "fetch") return { ...idle, note: { op, outcome, at: now } };
  if (outcome.kind === "done") return { ...idle, fetchedAt: now, fetchError: null };
  if (outcome.reason === "busy") return idle;
  return { ...idle, fetchError: firstLine(outcome.details) ?? outcome.message };
}

function firstLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/// Runs one network operation per checkout and remembers how each went. The
/// backend refuses a second one too; this is what keeps the panel from asking.
export class SyncStore {
  private state: ReadonlyMap<string, CheckoutSync> = new Map();
  private listeners = new Set<() => void>();

  /// `onSettled` runs after each operation, to reread the checkout.
  constructor(private onSettled: () => void) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;

  private of(checkout: string): CheckoutSync {
    return this.state.get(checkout) ?? IDLE;
  }

  private set(checkout: string, sync: CheckoutSync): void {
    this.state = new Map(this.state).set(checkout, sync);
    for (const listener of this.listeners) listener();
  }

  /// A background fetch, skipped when one ran a moment ago.
  fetch(checkout: string): void {
    const sync = this.of(checkout);
    if (!fetchDue(sync, Date.now())) return;
    this.set(checkout, { ...sync, triedAt: Date.now() });
    void this.run(checkout, "fetch", null);
  }

  /// `branch` is the one on show: the backend leaves a checkout that has moved
  /// off it alone.
  async run(checkout: string, op: SyncOp, branch: string | null): Promise<void> {
    if (this.of(checkout).running) return;
    this.set(checkout, { ...this.of(checkout), running: op });
    let outcome: SyncOutcome;
    try {
      outcome = await invoke<SyncOutcome>("sync_checkout", { checkout, op, branch });
    } catch (error) {
      outcome = { kind: "failed", reason: "other", message: String(error), details: "" };
    }
    this.set(checkout, settled(this.of(checkout), op, outcome, Date.now()));
    this.onSettled();
    // A rejected push usually means the remote moved, so show by how much.
    if (outcome.kind === "failed" && outcome.reason === "rejected") {
      await this.run(checkout, "fetch", null);
    }
  }

  dismiss(checkout: string): void {
    this.set(checkout, { ...this.of(checkout), note: null });
  }
}
