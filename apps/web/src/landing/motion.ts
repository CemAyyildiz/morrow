// Shared motion helpers for the landing: the mockup's clamp / cubic ease / lerp, the
// reduced-motion preference, and the collage's scroll-driven transforms.
import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";

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

/** Items hide until they scroll into view only with motion allowed and a way to tell. */
export function shouldReveal(reduced: boolean, canObserve: boolean): boolean {
  return !reduced && canObserve;
}

/** An item whose top is in or above the viewport is already seen: it never fades. */
export function alreadySeen(top: number, viewport: number): boolean {
  return top < viewport;
}

/**
 * Fades the `[data-reveal-item]` children of `root` in as they enter the viewport. It only
 * toggles attributes (`data-reveal` on the root, `data-shown` per item); landing.css draws the
 * fade, so nothing is styled inline. It arms before paint, and items already in or above the
 * viewport at that moment show at once, so nothing visible ever fades out. Under reduced
 * motion, or without IntersectionObserver, nothing is hidden and the items show at once.
 */
export function useReveal(root: RefObject<HTMLElement | null>, reduced: boolean) {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !shouldReveal(reduced, "IntersectionObserver" in window)) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>("[data-reveal-item]"));
    for (const item of items) {
      if (alreadySeen(item.getBoundingClientRect().top, window.innerHeight)) {
        item.dataset.shown = "";
      }
    }
    el.dataset.reveal = "";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.shown = "";
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.15 },
    );
    for (const item of items) if (!("shown" in item.dataset)) observer.observe(item);
    return () => {
      observer.disconnect();
      delete el.dataset.reveal;
      for (const item of items) delete item.dataset.shown;
    };
  }, [root, reduced]);
}
