// The feature accordion's auto-advance (EXPERIENCE.md): every 6 s while the list is in view,
// stopped for good by any click, and never under reduced motion. A plain controller so the
// timer rules are testable without a DOM.

export const AUTOPLAY_MS = 6000;

export interface AutoplayOptions {
  count: number;
  /** Called with the next item each time the accordion advances. */
  onAdvance: (index: number) => void;
  /** Called when auto-advance starts or stops, for the progress line. */
  onRunning?: (running: boolean) => void;
  reduced: boolean;
  interval?: number;
}

export interface Autoplay {
  /** The list entered or left the viewport. */
  setVisible: (visible: boolean) => void;
  /** The visitor chose an item: auto-advance stops for good. */
  choose: (index: number) => void;
  current: () => number;
  running: () => boolean;
  dispose: () => void;
}

export function createAutoplay({
  count,
  onAdvance,
  onRunning,
  reduced,
  interval = AUTOPLAY_MS,
}: AutoplayOptions): Autoplay {
  let index = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = reduced;

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    onRunning?.(false);
  };
  const start = () => {
    if (stopped || timer !== null) return;
    timer = setInterval(() => {
      index = (index + 1) % count;
      onAdvance(index);
    }, interval);
    onRunning?.(true);
  };

  return {
    setVisible: (visible) => (visible ? start() : stop()),
    choose: (next) => {
      stopped = true;
      stop();
      index = next;
      onAdvance(next);
    },
    current: () => index,
    running: () => timer !== null,
    dispose: () => {
      stopped = true;
      stop();
    },
  };
}
