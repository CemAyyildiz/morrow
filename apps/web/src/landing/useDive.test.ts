import { describe, expect, it } from "vitest";
import { collagePose, ease, trackProgress } from "./motion";
import { APP, DIVE_START, layout, robTarget, update } from "./useDive";

const MOTION = { sunUp: false, reduced: false };
const REDUCED = { sunUp: false, reduced: true };

describe("layout() at the mockup's desktop size, 1440 × 930", () => {
  const g = layout(1440, 930);

  it("covers the viewport with the still, height-bound", () => {
    expect(g.c).toBeCloseTo(930 / 3072, 12);
    expect(g.dw).toBeCloseTo(1666.25, 9);
    expect(g.dh).toBeCloseTo(930, 9);
    expect(g.ox).toBeCloseTo(-113.125, 9);
    // The laptop already sits above 60 % of the height: no vertical shift.
    expect(g.oy).toBe(0);
  });

  it("places the laptop screen and the 16:9 video crop in drawn pixels", () => {
    expect(g.s.x).toBeCloseTo(2510 * g.c, 9);
    expect(g.s.y).toBeCloseTo(1242 * g.c, 9);
    expect(g.s.w).toBeCloseTo(145.3125, 9);
    expect(g.s.h).toBeCloseTo(310 * g.c, 9);
    expect(g.video.left).toBeCloseTo(21.3 * g.c, 9);
    expect(g.video.width).toBeCloseTo((5504 - 42.6) * g.c, 9);
  });

  it("zooms until the screen fills 93 % of the height below the nav", () => {
    expect(g.k).toBeCloseTo((850 * 0.93) / g.s.h, 9);
    expect(g.k * g.s.w).toBeLessThan(1440 * 0.95);
  });
});

describe("layout() on a phone, 390 × 844", () => {
  const g = layout(390, 844);

  it("is height-bound and zooms until the screen fills 95 % of the width", () => {
    expect(g.c).toBeCloseTo(844 / 3072, 12);
    expect(g.oy).toBe(0);
    expect(g.k).toBeCloseTo((390 * 0.95) / g.s.w, 9);
  });
});

describe("update() on desktop", () => {
  const g = layout(1440, 930);

  it("rests at scroll 0: headline and legal line up, camera still, no product copy", () => {
    const f = update(g, 0, MOTION);
    expect(f.z).toBe(0);
    expect(f.world.scale).toBe(1);
    expect(f.world.tx).toBeCloseTo(g.ox, 9);
    expect(f.world.ty).toBeCloseTo(g.oy, 9);
    expect(f.headline).toEqual({ opacity: 1, y: -0, interactive: true });
    expect(f.legal).toBe(1);
    expect(f.crisp.opacity).toBe(0);
    expect(f.crisp.live).toBe(false);
    expect(f.video).toBe(1);
    expect(f.navSolid).toBe(false);
    expect(f.screenHidden).toBe(false);
  });

  it("fades the headline over the first 16 % and the nav goes solid after 2 %", () => {
    expect(update(g, 0.02, MOTION).navSolid).toBe(false);
    expect(update(g, 0.021, MOTION).navSolid).toBe(true);
    const half = update(g, 0.08, MOTION);
    expect(half.headline.opacity).toBeCloseTo(0.5, 9);
    expect(half.headline.y).toBeCloseTo(-20, 9);
    expect(half.legal).toBe(0);
    const gone = update(g, 0.16, MOTION);
    expect(gone.headline.opacity).toBe(0);
    expect(gone.headline.interactive).toBe(false);
  });

  it("eases the camera in from 8 % to 78 % with a cubic curve", () => {
    expect(update(g, DIVE_START, MOTION).z).toBe(0);
    expect(update(g, 0.43, MOTION).z).toBeCloseTo(0.5, 9);
    expect(update(g, 0.2, MOTION).z).toBeCloseTo(ease(0.12 / 0.7), 12);
    expect(update(g, 0.78, MOTION).z).toBe(1);
    // While the camera moves, the video steps aside for the light-matched still.
    expect(update(g, 0.2, MOTION).video).toBe(0);
  });

  it("ends with the crisp copy centred under the nav, at the product's 1440 × 930 ratio", () => {
    const f = update(g, 1, MOTION);
    expect(f.world.scale).toBeCloseTo(g.k, 9);
    expect(f.crisp.width).toBeCloseTo(1224, 6);
    expect(f.crisp.height).toBeCloseTo(790.5, 6);
    expect(f.crisp.left).toBeCloseTo(720 - 612, 6);
    expect(f.crisp.top).toBeCloseTo((930 + 72) / 2 - 790.5 / 2, 6);
    expect(f.crisp.scaleX).toBeCloseTo(f.crisp.width / APP.w, 12);
    expect(f.crisp.scaleY).toBeCloseTo(0.85, 9);
    expect(f.crisp.opacity).toBe(1);
    expect(f.crisp.live).toBe(true);
    expect(f.mob).toEqual({ opacity: 0, live: false });
    expect(f.screenHidden).toBe(true);
    expect(f.shade).toBe(1);
    expect(f.dim).toBeCloseTo(0.6, 9);
  });

  it("keeps the crisp copy exactly on the drawn screen while it fades in", () => {
    for (const p of [0.3, 0.55, 0.7]) {
      const f = update(g, p, MOTION);
      expect(f.crisp.left).toBeCloseTo(f.world.tx + f.world.scale * g.s.x, 9);
      expect(f.crisp.top).toBeCloseTo(f.world.ty + f.world.scale * g.s.y, 9);
      expect(f.crisp.width).toBeCloseTo(g.s.w * f.world.scale, 9);
    }
  });

  it("shows the gold still once the video's sun is up", () => {
    expect(update(g, 0, MOTION).gold).toBe(0);
    expect(update(g, 0, { sunUp: true, reduced: false }).gold).toBe(1);
  });
});

describe("update() on a phone", () => {
  const g = layout(390, 844);

  it("ends on the phone re-flow, never the crisp copy", () => {
    const f = update(g, 1, MOTION);
    expect(f.crisp.opacity).toBe(0);
    expect(f.crisp.live).toBe(false);
    expect(f.mob).toEqual({ opacity: 1, live: true });
    expect(f.screenHidden).toBe(true);
  });

  it("switches at 820 px", () => {
    expect(update(layout(819, 844), 1, MOTION).mob.opacity).toBe(1);
    expect(update(layout(820, 844), 1, MOTION).crisp.opacity).toBe(1);
  });
});

describe("update() with reduced motion: a direct cut", () => {
  const g = layout(1440, 930);

  it("holds the scene still before the dive starts", () => {
    const f = update(g, DIVE_START - 0.001, REDUCED);
    expect(f.z).toBe(0);
    expect(f.headline.opacity).toBe(1);
    expect(f.legal).toBe(1);
    expect(f.crisp.opacity).toBe(0);
  });

  it("cuts straight to the product once the dive would start", () => {
    for (const p of [DIVE_START, 0.3, 1]) {
      const f = update(g, p, REDUCED);
      expect(f.z).toBe(1);
      expect(f.headline.opacity).toBe(0);
      expect(f.crisp.opacity).toBe(1);
      expect(f.crisp.live).toBe(true);
      expect(f.crisp.width).toBeCloseTo(1224, 6);
    }
    expect(update(layout(390, 844), DIVE_START, REDUCED).mob.opacity).toBe(1);
  });
});

describe("scroll helpers", () => {
  it("measures progress through a sticky track", () => {
    expect(trackProgress(0, 4092, 930)).toBe(0);
    expect(trackProgress(-1581, 4092, 930)).toBeCloseTo(0.5, 9);
    expect(trackProgress(-9999, 4092, 930)).toBe(1);
    expect(trackProgress(500, 4092, 930)).toBe(0);
    expect(trackProgress(0, 900, 930)).toBe(0);
  });

  it('puts "Rob this vault" at 90 % of the stage', () => {
    expect(robTarget(0, 4092, 930)).toBeCloseTo(0.9 * 3162, 9);
    expect(robTarget(100, 4092, 930)).toBeCloseTo(100 + 0.9 * 3162, 9);
  });
});

describe("collagePose()", () => {
  it("slides the marquee, turns the phone and drifts the tiles with scroll", () => {
    const start = collagePose(0, 1440, 930, false);
    const end = collagePose(1, 1440, 930, false);
    expect(start.marqueeX).toBeCloseTo(0.15 * 1440, 9);
    expect(end.marqueeX).toBeCloseTo(-0.95 * 1440, 9);
    expect(start.phone).toEqual([-28, 8, -6]);
    expect(end.phone).toEqual([28, -2, 4]);
    expect(start.tileY(0.45)).toBeCloseTo(-0.5 * 0.45 * 930, 9);
    expect(collagePose(0.5, 1440, 930, false).tileY(0.45)).toBe(0);
  });

  it("holds everything still under reduced motion", () => {
    const a = collagePose(0, 1440, 930, true);
    const b = collagePose(1, 1440, 930, true);
    expect(a.marqueeX).toBe(b.marqueeX);
    expect(a.phone).toEqual(b.phone);
    expect(a.tileY(0.45)).toBe(0);
    expect(b.tileY(-0.4)).toBe(0);
  });
});
