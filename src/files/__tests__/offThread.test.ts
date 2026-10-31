import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Token } from "../highlight";

const tokens: Token[][] = [[{ content: "a" }]];

class FakeWorker extends EventTarget {
  static last: FakeWorker;
  sent: unknown[] = [];
  constructor() {
    super();
    FakeWorker.last = this;
  }
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  reply(id: number, reply: Token[][] | null) {
    this.dispatchEvent(Object.assign(new Event("message"), { data: { id, tokens: reply } }));
  }
}

async function load() {
  vi.resetModules();
  return (await import("../offThread")).highlightOffThread;
}

describe("highlightOffThread", () => {
  beforeEach(() => vi.stubGlobal("Worker", FakeWorker));

  it("gives each file its own reply, whatever order they come back in", async () => {
    const highlightOffThread = await load();
    const signal = new AbortController().signal;
    const first = highlightOffThread("one", "a.ts", signal);
    const second = highlightOffThread("two", "b.ts", signal);
    expect(FakeWorker.last.sent).toEqual([
      { id: 0, code: "one", path: "a.ts" },
      { id: 1, code: "two", path: "b.ts" },
    ]);
    FakeWorker.last.reply(1, tokens);
    FakeWorker.last.reply(0, null);
    expect(await second).toBe(tokens);
    expect(await first).toBeNull();
  });

  it("settles an abort at once, tells the worker, and ignores a late reply", async () => {
    const highlightOffThread = await load();
    const left = new AbortController();
    const pending = highlightOffThread("one", "a.ts", left.signal);
    left.abort();
    expect(await pending).toBeNull();
    expect(FakeWorker.last.sent).toContainEqual({ cancel: 0 });
    FakeWorker.last.reply(0, tokens);
  });

  it("goes plain when the worker fails, and the next file gets a new one", async () => {
    const highlightOffThread = await load();
    const signal = new AbortController().signal;
    const pending = highlightOffThread("one", "a.ts", signal);
    const broken = FakeWorker.last;
    broken.dispatchEvent(new Event("error"));
    expect(await pending).toBeNull();
    void highlightOffThread("two", "b.ts", signal);
    expect(FakeWorker.last).not.toBe(broken);
  });
});
