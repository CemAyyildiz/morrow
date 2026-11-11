import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FCP_WAIT_MS, afterFirstContentfulPaint, afterNextPaint } from "./motion";

// Story 9.5: the hero's media waits for the first contentful paint. These pin the helper's
// three paths (the paint entry, the timeout, no paint timing) and its cancel.

/** A `requestAnimationFrame` stand-in: frames run when `flushFrames` is called. */
function stubFrames() {
  let frames = new Map<number, () => void>();
  let next = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(next, callback);
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  return () => {
    const due = frames;
    frames = new Map();
    for (const callback of due.values()) callback();
  };
}

/** A `PerformanceObserver` that supports `paint` and lets the test deliver entries. */
function stubPaintObserver() {
  const observers: {
    callback: (list: { getEntriesByName: (n: string) => unknown[] }) => void;
    connected: boolean;
  }[] = [];
  class FakeObserver {
    static supportedEntryTypes = ["paint", "largest-contentful-paint"];
    private readonly entry;
    constructor(callback: (list: { getEntriesByName: (n: string) => unknown[] }) => void) {
      this.entry = { callback, connected: false };
      observers.push(this.entry);
    }
    observe() {
      this.entry.connected = true;
    }
    disconnect() {
      this.entry.connected = false;
    }
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
  return {
    paint(name: string) {
      for (const observer of observers.filter((o) => o.connected)) {
        observer.callback({ getEntriesByName: (n) => (n === name ? [{ name }] : []) });
      }
    },
    connected: () => observers.filter((o) => o.connected).length,
  };
}

describe("afterNextPaint", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs in a task after the next frame, not in the frame itself", () => {
    const flush = stubFrames();
    const run = vi.fn();
    afterNextPaint(run);
    expect(run).not.toHaveBeenCalled();
    flush();
    expect(run).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(run).toHaveBeenCalledOnce();
  });

  it("never runs once cancelled, before or after the frame", () => {
    const flush = stubFrames();
    const early = vi.fn();
    afterNextPaint(early)();
    flush();
    vi.runAllTimers();
    expect(early).not.toHaveBeenCalled();

    const late = vi.fn();
    const cancel = afterNextPaint(late);
    flush();
    cancel();
    vi.runAllTimers();
    expect(late).not.toHaveBeenCalled();
  });
});

describe("afterFirstContentfulPaint", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs once on the first-contentful-paint entry and stops observing", () => {
    const paints = stubPaintObserver();
    const run = vi.fn();
    afterFirstContentfulPaint(run);
    paints.paint("first-paint");
    expect(run).not.toHaveBeenCalled();
    paints.paint("first-contentful-paint");
    expect(run).toHaveBeenCalledOnce();
    expect(paints.connected()).toBe(0);
    vi.advanceTimersByTime(FCP_WAIT_MS * 2);
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs after FCP_WAIT_MS when no paint entry comes (a tab opened in the background)", () => {
    const paints = stubPaintObserver();
    const run = vi.fn();
    afterFirstContentfulPaint(run);
    vi.advanceTimersByTime(FCP_WAIT_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledOnce();
    expect(paints.connected()).toBe(0);
  });

  it("falls back to the next painted frame without paint timing", () => {
    vi.stubGlobal("PerformanceObserver", { supportedEntryTypes: ["mark", "measure"] });
    const flush = stubFrames();
    const run = vi.fn();
    afterFirstContentfulPaint(run);
    flush();
    vi.runAllTimers();
    expect(run).toHaveBeenCalledOnce();
  });

  it("never runs once cancelled", () => {
    const paints = stubPaintObserver();
    const run = vi.fn();
    afterFirstContentfulPaint(run)();
    expect(paints.connected()).toBe(0);
    paints.paint("first-contentful-paint");
    vi.advanceTimersByTime(FCP_WAIT_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});
