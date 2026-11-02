import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOPLAY_MS, createAutoplay } from "./autoplay";

function setup(reduced = false) {
  const advanced: number[] = [];
  const running: boolean[] = [];
  const autoplay = createAutoplay({
    count: 5,
    reduced,
    onAdvance: (index) => advanced.push(index),
    onRunning: (value) => running.push(value),
  });
  return { autoplay, advanced, running };
}

describe("feature accordion autoplay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits until the list is in view", () => {
    const { advanced } = setup();
    vi.advanceTimersByTime(AUTOPLAY_MS * 3);
    expect(advanced).toEqual([]);
  });

  it("advances every 6 s while in view and wraps after the last item", () => {
    const { autoplay, advanced, running } = setup();
    autoplay.setVisible(true);
    expect(running).toEqual([true]);
    vi.advanceTimersByTime(AUTOPLAY_MS - 1);
    expect(advanced).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(advanced).toEqual([1]);
    vi.advanceTimersByTime(AUTOPLAY_MS * 4);
    expect(advanced).toEqual([1, 2, 3, 4, 0]);
    expect(autoplay.current()).toBe(0);
  });

  it("pauses out of view and starts a fresh 6 s when back", () => {
    const { autoplay, advanced, running } = setup();
    autoplay.setVisible(true);
    vi.advanceTimersByTime(AUTOPLAY_MS - 1000);
    autoplay.setVisible(false);
    vi.advanceTimersByTime(AUTOPLAY_MS * 2);
    expect(advanced).toEqual([]);
    autoplay.setVisible(true);
    vi.advanceTimersByTime(AUTOPLAY_MS - 1);
    expect(advanced).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(advanced).toEqual([1]);
    expect(running).toEqual([true, false, true]);
  });

  it("stops for good on a click", () => {
    const { autoplay, advanced } = setup();
    autoplay.setVisible(true);
    autoplay.choose(3);
    expect(advanced).toEqual([3]);
    expect(autoplay.running()).toBe(false);
    autoplay.setVisible(false);
    autoplay.setVisible(true);
    vi.advanceTimersByTime(AUTOPLAY_MS * 5);
    expect(advanced).toEqual([3]);
    expect(autoplay.current()).toBe(3);
  });

  it("never runs under reduced motion, while clicks still choose", () => {
    const { autoplay, advanced, running } = setup(true);
    autoplay.setVisible(true);
    vi.advanceTimersByTime(AUTOPLAY_MS * 5);
    expect(advanced).toEqual([]);
    expect(running).toEqual([]);
    autoplay.choose(2);
    expect(advanced).toEqual([2]);
  });

  it("stops on dispose", () => {
    const { autoplay, advanced } = setup();
    autoplay.setVisible(true);
    autoplay.dispose();
    vi.advanceTimersByTime(AUTOPLAY_MS * 2);
    expect(advanced).toEqual([]);
  });
});
