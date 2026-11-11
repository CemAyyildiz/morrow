// The hero dive, 1:1 with the mockup script (mockups/landing/index.html lines 304–336):
// `layout()` fits the scene to the viewport, `update()` turns scroll progress into the
// camera, the crossfades and the crisp product copy. Both are pure so they can be tested at
// fixed viewports; `useDive` writes their output through refs and the CSSOM.
import { useEffect, useLayoutEffect, type RefObject } from "react";
import { clamp, ease, lerp, trackProgress } from "./motion";

/** The still, in its own pixels. */
export const IMG = { w: 5504, h: 3072 } as const;
/** The laptop screen inside the still. */
export const SCR = { x: 2510, y: 1242, w: 480, h: 310 } as const;
/** The video is the 16:9 centre crop of the still. */
export const VID = { x: 21.3, w: 5504 - 42.6 } as const;
/** The product is designed at 1440 × 930. */
export const APP = { w: 1440, h: 930 } as const;
/** Below this width the dive ends on the phone re-flow instead of the crisp copy. */
export const PHONE_BELOW = 820;
/** The video frame after which the gold still matches its light. */
export const SUN_UP_AT = 4.2;
/** "Rob this vault" lands here in the stage: the product end of the dive. */
export const ROB_AT = 0.9;
/** Where the camera starts to move; reduced motion cuts to the product here. */
export const DIVE_START = 0.08;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiveLayout {
  vw: number;
  vh: number;
  /** Still pixels to CSS pixels: the scene covers the viewport. */
  c: number;
  /** The drawn size of the still. */
  dw: number;
  dh: number;
  /** The still's offset at rest: centred, the laptop raised to 60 % of the height. */
  ox: number;
  oy: number;
  /** The laptop screen in drawn pixels, relative to the still. */
  s: Rect;
  /** The camera's final zoom: the screen fills 95 % of the width or 93 % of the height. */
  k: number;
  /** The video's left edge and width in drawn pixels. */
  video: { left: number; width: number };
}

export function layout(vw: number, vh: number): DiveLayout {
  const c = Math.max(vw / IMG.w, vh / IMG.h);
  const dw = IMG.w * c;
  const dh = IMG.h * c;
  const ox = (vw - dw) / 2;
  const oy = Math.min(0, Math.max(vh - dh, vh * 0.6 - (SCR.y + SCR.h / 2) * c));
  const s = { x: SCR.x * c, y: SCR.y * c, w: SCR.w * c, h: SCR.h * c };
  const k = Math.min((vw * 0.95) / s.w, ((vh - 80) * 0.93) / s.h);
  return { vw, vh, c, dw, dh, ox, oy, s, k, video: { left: VID.x * c, width: VID.w * c } };
}

export interface DiveFrame {
  /** Eased zoom progress, 0 at rest and 1 at the product. */
  z: number;
  world: { tx: number; ty: number; scale: number };
  /** The crisp product copy: the on-screen rectangle of the laptop screen. */
  crisp: {
    left: number;
    top: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
    live: boolean;
  };
  mob: { opacity: number; live: boolean };
  /** The drawn screen hides once a copy has fully replaced it (no double image). */
  screenHidden: boolean;
  gold: number;
  video: number;
  headline: { opacity: number; y: number; interactive: boolean };
  legal: number;
  shade: number;
  dim: number;
  navSolid: boolean;
}

export interface DiveInput {
  /** The video has passed `SUN_UP_AT` or ended: the gold still matches it. */
  sunUp: boolean;
  /** prefers-reduced-motion: the dive is a direct cut to the product. */
  reduced: boolean;
}

/** The dive at scroll progress `p` (0 to 1 through the stage). */
export function update(g: DiveLayout, p: number, { sunUp, reduced }: DiveInput): DiveFrame {
  const { vw, vh, ox, oy, s, k } = g;
  const cut = p >= DIVE_START;
  const z = reduced ? (cut ? 1 : 0) : ease(clamp((p - DIVE_START) / 0.7));
  const Z = lerp(1, k, z);
  const c0x = ox + s.x + s.w / 2;
  const c0y = oy + s.y + s.h / 2;
  const tcx = lerp(c0x, vw / 2, z);
  const tcy = lerp(c0y, (vh + 72) / 2, z);
  const tx = tcx - Z * (s.x + s.w / 2);
  const ty = tcy - Z * (s.y + s.h / 2);

  const cw = s.w * Z;
  const ch = s.h * Z;
  const f = reduced ? (cut ? 1 : 0) : clamp(p / 0.16);
  const cf = clamp((z - 0.8) / 0.15);
  const phone = vw < PHONE_BELOW;
  // (z - 0.9) / 0.1 at z = 1 is 0.9999999999999998: round so the phone view reaches 1 and
  // the drawn screen can hide under it.
  const mf = phone ? clamp(Math.round(((z - 0.9) / 0.1) * 1e9) / 1e9) : 0;

  return {
    z,
    world: { tx, ty, scale: Z },
    crisp: {
      left: tx + Z * s.x,
      top: ty + Z * s.y,
      width: cw,
      height: ch,
      scaleX: cw / APP.w,
      scaleY: ch / APP.h,
      opacity: phone ? 0 : cf,
      live: !phone && cf > 0.6,
    },
    mob: { opacity: mf, live: mf > 0.6 },
    screenHidden: (!phone && cf >= 1) || (phone && mf >= 1),
    gold: sunUp ? 1 : 0,
    video: z > 0.01 ? 0 : 1,
    headline: { opacity: 1 - f, y: -40 * f, interactive: f <= 0.5 },
    legal: reduced ? (cut ? 0 : 1) : 1 - clamp(p / DIVE_START),
    shade: clamp((z - 0.25) / 0.6),
    dim: clamp((z - 0.5) / 0.5) * 0.6,
    navSolid: p > 0.02,
  };
}

/** The document scroll offset at which the stage shows the product ("Rob this vault"). */
export function robTarget(stageTop: number, stageHeight: number, viewport: number): number {
  return stageTop + (stageHeight - viewport) * ROB_AT;
}

export interface DiveRefs {
  scroll: RefObject<HTMLDivElement | null>;
  world: RefObject<HTMLDivElement | null>;
  scene: RefObject<HTMLImageElement | null>;
  gold: RefObject<HTMLImageElement | null>;
  video: RefObject<HTMLVideoElement | null>;
  dim: RefObject<HTMLDivElement | null>;
  screen: RefObject<HTMLDivElement | null>;
  screenApp: RefObject<HTMLDivElement | null>;
  shade: RefObject<HTMLDivElement | null>;
  crisp: RefObject<HTMLDivElement | null>;
  crispApp: RefObject<HTMLDivElement | null>;
  mob: RefObject<HTMLDivElement | null>;
  headline: RefObject<HTMLDivElement | null>;
  legal: RefObject<HTMLDivElement | null>;
  nav: RefObject<HTMLElement | null>;
}

const px = (v: number) => `${v}px`;

function place(el: HTMLElement | null, left: number, top: number, width: number, height: number) {
  if (!el) return;
  el.style.left = px(left);
  el.style.top = px(top);
  el.style.width = px(width);
  el.style.height = px(height);
}

/** A copy of the product that only takes input once it has replaced the drawn screen. */
function setLive(el: HTMLElement | null, live: boolean) {
  if (!el) return;
  if (live) {
    el.dataset.live = "";
    el.removeAttribute("aria-hidden");
  } else {
    delete el.dataset.live;
    el.setAttribute("aria-hidden", "true");
  }
  el.inert = !live;
}

function applyLayout(r: DiveRefs, g: DiveLayout) {
  const world = r.world.current;
  if (world) {
    world.style.width = px(g.dw);
    world.style.height = px(g.dh);
  }
  place(r.scene.current, 0, 0, g.dw, g.dh);
  place(r.gold.current, 0, 0, g.dw, g.dh);
  place(r.video.current, g.video.left, 0, g.video.width, g.dh);
  place(r.screen.current, g.s.x, g.s.y, g.s.w, g.s.h);
  const app = r.screenApp.current;
  if (app) app.style.transform = `scale(${g.s.w / APP.w},${g.s.h / APP.h})`;
}

function applyFrame(r: DiveRefs, f: DiveFrame) {
  const world = r.world.current;
  if (world) {
    world.style.transform = `translate(${px(f.world.tx)},${px(f.world.ty)}) scale(${f.world.scale})`;
  }
  const crisp = r.crisp.current;
  if (crisp) {
    place(crisp, f.crisp.left, f.crisp.top, f.crisp.width, f.crisp.height);
    crisp.style.opacity = String(f.crisp.opacity);
  }
  setLive(crisp, f.crisp.live);
  const crispApp = r.crispApp.current;
  if (crispApp) crispApp.style.transform = `scale(${f.crisp.scaleX},${f.crisp.scaleY})`;

  const mob = r.mob.current;
  if (mob) mob.style.opacity = String(f.mob.opacity);
  setLive(mob, f.mob.live);

  const screen = r.screen.current;
  if (screen) screen.style.visibility = f.screenHidden ? "hidden" : "visible";
  if (r.gold.current) r.gold.current.style.opacity = String(f.gold);
  if (r.video.current) r.video.current.style.opacity = String(f.video);

  const headline = r.headline.current;
  if (headline) {
    headline.style.opacity = String(f.headline.opacity);
    headline.style.transform = `translateY(${px(f.headline.y)})`;
    headline.style.pointerEvents = f.headline.interactive ? "auto" : "none";
  }
  if (r.legal.current) r.legal.current.style.opacity = String(f.legal);
  if (r.shade.current) r.shade.current.style.opacity = String(f.shade);
  if (r.dim.current) r.dim.current.style.opacity = String(f.dim);

  const nav = r.nav.current;
  if (nav) {
    if (f.navSolid) nav.dataset.solid = "";
    else delete nav.dataset.solid;
  }
}

function sunUp(video: HTMLVideoElement | null): boolean {
  return video !== null && (video.ended || video.currentTime > SUN_UP_AT);
}

/**
 * Runs the dive: lays the scene out on mount, on resize and when the still loads, and
 * re-renders the frame on every scroll and on the video's sunrise. The first layout is a
 * layout effect, so the first paint already has the scene placed: an effect would paint the
 * video at its 300 × 150 default and the still at its natural size first (a layout shift).
 */
export function useDive(refs: DiveRefs, reduced: boolean) {
  useLayoutEffect(() => {
    let g = layout(window.innerWidth, window.innerHeight);

    const frame = () => {
      const scroll = refs.scroll.current;
      if (!scroll) return;
      const p = trackProgress(
        scroll.getBoundingClientRect().top,
        scroll.offsetHeight,
        window.innerHeight,
      );
      applyFrame(refs, update(g, p, { sunUp: sunUp(refs.video.current), reduced }));
    };
    const relayout = () => {
      g = layout(window.innerWidth, window.innerHeight);
      applyLayout(refs, g);
      frame();
    };
    const onTime = () => {
      if ((refs.video.current?.currentTime ?? 0) > SUN_UP_AT) frame();
    };

    relayout();
    const scene = refs.scene.current;
    const video = refs.video.current;
    window.addEventListener("resize", relayout);
    window.addEventListener("scroll", frame, { passive: true });
    scene?.addEventListener("load", relayout);
    video?.addEventListener("ended", frame);
    video?.addEventListener("timeupdate", onTime);
    return () => {
      window.removeEventListener("resize", relayout);
      window.removeEventListener("scroll", frame);
      scene?.removeEventListener("load", relayout);
      video?.removeEventListener("ended", frame);
      video?.removeEventListener("timeupdate", onTime);
    };
  }, [refs, reduced]);
}

/**
 * Plays the hero video once (dawn to sunrise), unless motion is reduced: then it is never
 * requested. It waits for the scene still (`sceneReady`), so on a slow connection the 7 MB
 * video never competes with the first paint. A missing video is silent; the still carries the
 * scene.
 */
export function useHeroVideo(
  video: RefObject<HTMLVideoElement | null>,
  src: string,
  poster: string,
  reduced: boolean,
  sceneReady: boolean,
) {
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (reduced) {
      el.pause();
      return;
    }
    if (el.currentSrc !== "") {
      // Already loaded (a reduced-motion toggle back off): keep the frame it reached.
      return;
    }
    if (!sceneReady) return;
    const abort = new AbortController();
    fetch(src, { method: "HEAD", signal: abort.signal })
      .then((response) => {
        if (!response.ok || abort.signal.aborted) return;
        el.poster = poster;
        el.src = src;
        el.play().catch(() => undefined);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [video, src, poster, reduced, sceneReady]);
}
