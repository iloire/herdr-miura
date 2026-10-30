import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutChanges } from "../store";
import { FETCH_GAP_MS, IDLE, SyncStore, fetchDue, settled, syncOffer, type SyncOutcome } from "../sync";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const checkout = (over: Partial<CheckoutChanges> = {}): CheckoutChanges => ({
  path: "/repo",
  branch: "main",
  upstream: "origin/main",
  upstream_gone: false,
  ahead: 0,
  behind: 0,
  born: true,
  operation: null,
  remotes: ["origin"],
  unmerged: null,
  files: [],
  total_files: 0,
  added: 0,
  removed: 0,
  commits: [],
  ...over,
});

const failed = (reason: "rejected" | "diverged" | "busy" | "other", details = ""): SyncOutcome => ({
  kind: "failed",
  reason,
  message: "It failed.",
  details,
});

describe("syncOffer", () => {
  it("offers Push, Pull and the lists on a tracked branch", () => {
    expect(syncOffer(checkout())).toEqual({ tracked: true, publish: false, note: null });
  });

  it("offers Publish on a branch with no upstream", () => {
    expect(syncOffer(checkout({ upstream: null }))).toEqual({ tracked: false, publish: true, note: null });
  });

  it("does not publish to an origin that does not exist", () => {
    expect(syncOffer(checkout({ upstream: null, remotes: ["fork"] })).publish).toBe(false);
  });

  it("offers nothing without a remote", () => {
    expect(syncOffer(checkout({ upstream: null, remotes: [] }))).toEqual({ tracked: false, publish: false, note: null });
  });

  it("offers nothing on a detached HEAD", () => {
    expect(syncOffer(checkout({ branch: null, upstream: null }))).toEqual({ tracked: false, publish: false, note: null });
  });

  it("offers nothing on an unborn branch, tracked or not", () => {
    for (const upstream of [null, "origin/main"]) {
      expect(syncOffer(checkout({ born: false, upstream }))).toEqual({ tracked: false, publish: false, note: null });
    }
  });

  it("offers nothing during a rebase or a merge, and says why", () => {
    for (const operation of ["rebase", "merge"] as const) {
      const offer = syncOffer(checkout({ operation, ahead: 2 }));
      expect(offer.tracked || offer.publish).toBe(false);
      expect(offer.note).toContain(operation);
    }
  });

  it("does not publish a branch during a merge", () => {
    expect(syncOffer(checkout({ operation: "merge", upstream: null })).publish).toBe(false);
  });

  it("says when the upstream is gone, and does not recreate it", () => {
    const offer = syncOffer(checkout({ upstream_gone: true }));
    expect(offer).toMatchObject({ tracked: false, publish: false });
    expect(offer.note).toContain("gone");
  });

  it("says so when the branches have diverged, and only then", () => {
    expect(syncOffer(checkout({ ahead: 1, behind: 2 })).note).toContain("Diverged");
    expect(syncOffer(checkout({ ahead: 1 })).note).toBeNull();
    expect(syncOffer(checkout({ behind: 2 })).note).toBeNull();
  });
});

describe("fetchDue", () => {
  it("is due the first time", () => {
    expect(fetchDue(IDLE, 0)).toBe(true);
  });

  it("waits out the gap", () => {
    const sync = { ...IDLE, triedAt: 1000 };
    expect(fetchDue(sync, 1000 + FETCH_GAP_MS - 1)).toBe(false);
    expect(fetchDue(sync, 1000 + FETCH_GAP_MS)).toBe(true);
  });

  it("is never due while something runs", () => {
    expect(fetchDue({ ...IDLE, running: "push" }, 0)).toBe(false);
  });
});

describe("settled", () => {
  it("records when a fetch worked and clears its last failure", () => {
    const sync = settled({ ...IDLE, running: "fetch", fetchError: "old" }, "fetch", { kind: "done" }, 500);
    expect(sync).toMatchObject({ running: null, fetchedAt: 500, fetchError: null });
  });

  it("keeps a failed fetch quiet: no note, and the last good time stays", () => {
    const before = { ...IDLE, running: "fetch" as const, fetchedAt: 100 };
    const sync = settled(before, "fetch", failed("other", "\n fatal: unable to access\nmore"), 500);
    expect(sync).toMatchObject({ running: null, fetchedAt: 100, fetchError: "fatal: unable to access", note: null });
  });

  it("falls back to the message when Git said nothing", () => {
    expect(settled(IDLE, "fetch", failed("other"), 0).fetchError).toBe("It failed.");
  });

  it("says nothing about a fetch turned away by a busy checkout", () => {
    expect(settled({ ...IDLE, running: "fetch" }, "fetch", failed("busy"), 0)).toEqual(IDLE);
  });

  it("keeps a push's result as a note, and a fetch does not replace it", () => {
    const outcome = failed("rejected");
    const pushed = settled({ ...IDLE, running: "push" }, "push", outcome, 500);
    expect(pushed).toMatchObject({ running: null, note: { op: "push", outcome, at: 500 } });
    expect(settled(pushed, "fetch", { kind: "done" }, 600).note).toEqual(pushed.note);
  });
});

describe("SyncStore", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("starts one operation however many clicks arrive", async () => {
    let finish = (_: SyncOutcome) => {};
    invoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const reread = vi.fn();
    const store = new SyncStore(reread);
    const first = store.run("/repo", "push", "main");
    void store.run("/repo", "push", "main");
    void store.run("/repo", "pull", "main");
    expect(store.getState().get("/repo")?.running).toBe("push");
    expect(invoke).toHaveBeenCalledTimes(1);
    finish({ kind: "done" });
    await first;
    expect(store.getState().get("/repo")?.running).toBeNull();
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("runs in each checkout independently", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    const store = new SyncStore(() => {});
    void store.run("/one", "push", "main");
    void store.run("/two", "push", "main");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("passes the branch on show", async () => {
    invoke.mockResolvedValue({ kind: "done" });
    await new SyncStore(() => {}).run("/repo", "publish", "feat/x");
    expect(invoke).toHaveBeenCalledWith("sync_checkout", { checkout: "/repo", op: "publish", branch: "feat/x" });
  });

  it("fetches after a rejected push, to show how far the remote moved", async () => {
    invoke.mockResolvedValueOnce(failed("rejected")).mockResolvedValueOnce({ kind: "done" });
    const reread = vi.fn();
    const store = new SyncStore(reread);
    await store.run("/repo", "push", "main");
    expect(invoke.mock.calls.map(([, args]) => args.op)).toEqual(["push", "fetch"]);
    expect(reread).toHaveBeenCalledTimes(2);
    expect(store.getState().get("/repo")?.note?.outcome).toEqual(failed("rejected"));
    expect(store.getState().get("/repo")?.fetchedAt).not.toBeNull();
  });

  it("does not fetch after any other failure", async () => {
    invoke.mockResolvedValueOnce(failed("diverged"));
    await new SyncStore(() => {}).run("/repo", "pull", "main");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("turns a refused call into a note rather than throwing", async () => {
    invoke.mockRejectedValueOnce("that workspace is on another machine");
    const store = new SyncStore(() => {});
    await store.run("/repo", "push", "main");
    expect(store.getState().get("/repo")?.note?.outcome).toMatchObject({
      kind: "failed",
      message: "that workspace is on another machine",
    });
  });

  it("fetches once per gap", () => {
    invoke.mockReturnValue(new Promise(() => {}));
    const store = new SyncStore(() => {});
    store.fetch("/repo");
    store.fetch("/repo");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("counts a failed fetch against the gap", async () => {
    invoke.mockResolvedValue(failed("other"));
    const store = new SyncStore(() => {});
    store.fetch("/repo");
    await vi.waitFor(() => expect(store.getState().get("/repo")?.running).toBeNull());
    store.fetch("/repo");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("forgets a note when dismissed", async () => {
    invoke.mockResolvedValue({ kind: "done" });
    const store = new SyncStore(() => {});
    await store.run("/repo", "push", "main");
    store.dismiss("/repo");
    expect(store.getState().get("/repo")?.note).toBeNull();
  });
});
