// Shared motion helpers for the landing: the mockup's clamp / cubic ease / lerp, the
// reduced-motion preference, and the collage's scroll-driven transforms.
import { useSyncExternalStore } from "react";

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** Cubic ease-in-out. */
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True while the visitor asks for reduced motion; follows changes live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/** Scroll progress through a sticky track: 0 when its top meets the viewport top, 1 at its end. */
export function trackProgress(top: number, height: number, viewport: number): number {
  const total = height - viewport;
  return total > 0 ? clamp(-top / total) : 0;
}

export interface CollagePose {
  /** Marquee: translateX in px (translateY stays -50%). */
  marqueeX: number;
  /** Phone body: rotateY, rotateX, rotateZ in degrees. */
  phone: [number, number, number];
  /** Tile translateY in px for a tile of parallax speed `s`. */
  tileY: (s: number) => number;
}

/**
 * The collage at progress `t` through its 300 vh track, for a `vw` × `vh` viewport. Reduced
 * motion freezes it: the marquee rests at its start, the phone faces the reader, tiles hold.
 */
export function collagePose(t: number, vw: number, vh: number, reduced: boolean): CollagePose {
  if (reduced) {
    return { marqueeX: 0.15 * vw, phone: [0, 3, -1], tileY: () => 0 };
  }
  return {
    marqueeX: (0.15 - t * 1.1) * vw,
    phone: [-28 + 56 * t, 8 - 10 * t, -6 + 10 * t],
    tileY: (s) => (t - 0.5) * s * vh,
  };
}
