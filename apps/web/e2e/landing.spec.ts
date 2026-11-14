import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { layout, update } from "../src/landing/useDive.ts";
import { BACKEND_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// Story 9.1: the landing at `/`, against the production build, at the mockup's desktop size
// and at a phone size. Screenshots at scroll 0 / 50 % / end are saved as test artifacts; when
// the approved mockup is on disk, its geometry at 0 / 40 / 100 % is compared too.

const MAX_VIDEO_BYTES = 8_000_000;
const CONFIGURED = new Set([RPC_URL, BACKEND_URL, WATCHER_URL].map((url) => new URL(url).origin));
const MOCKUP_PATH =
  "_bmad-output/planning-artifacts/ux-designs/ux-morrow-2026-10-29/mockups/landing";

const isPhone = (info: TestInfo) => info.project.name === "phone";

/** The approved mockup, found from the working directory upwards (worktrees included). */
function findMockup(): string | null {
  const override = process.env.MORROW_MOCKUP_DIR;
  if (override)
    return existsSync(join(override, "index.html")) ? join(override, "index.html") : null;
  let dir = resolve(process.cwd());
  for (;;) {
    const candidate = join(dir, MOCKUP_PATH, "index.html");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** Opens the landing, records every request, waits for fonts and the scene. */
async function open(page: Page): Promise<Request[]> {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bitcoin that can't be rushed.");
  return requests;
}

/** Scrolls to progress `p` through the hero stage (mockup: `#scroll`; build: the stage). */
async function scrollStage(page: Page, p: number, selector = "[data-testid=landing-stage]") {
  await page.evaluate(
    ({ p, selector }) => {
      const stage = document.querySelector<HTMLElement>(selector);
      if (!stage) throw new Error(`no ${selector}`);
      const top = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + (stage.offsetHeight - window.innerHeight) * p);
    },
    { p, selector },
  );
  await settle(page);
}

/** The copy of the product that is live at the end of the dive on this viewport. */
const liveProduct = (page: Page, info: TestInfo) =>
  page.getByTestId(isPhone(info) ? "landing-mobview" : "landing-crisp");

async function shoot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("scroll 0 → end dives into the product, with screenshots", async ({ page }, info) => {
  await open(page);
  await expect(page.locator(".l-nav")).not.toHaveAttribute("data-solid");
  await shoot(page, info, "landing-0");

  await scrollStage(page, 0.5);
  await expect(page.locator(".l-nav")).toHaveAttribute("data-solid", "");
  await expect(page.locator(".l-headline")).toHaveCSS("opacity", "0");
  await shoot(page, info, "landing-50");

  await scrollStage(page, 1);
  const product = liveProduct(page, info);
  await expect(product).toHaveCSS("opacity", "1");
  await expect(product).toHaveAttribute("data-live", "");
  await expect(product.getByRole("heading", { name: "Challenge vault" })).toBeVisible();
  await expect(product.getByRole("button", { name: "Try with these keys" })).toBeVisible();
  // The drawn screen is gone once the copy has replaced it: no double image.
  await expect(page.locator(".l-screen")).toHaveCSS("visibility", "hidden");
  // The other copy stays out of reach.
  const other = page.getByTestId(isPhone(info) ? "landing-crisp" : "landing-mobview");
  await expect(other).toHaveCSS("opacity", "0");
  await expect(other).toHaveAttribute("aria-hidden", "true");
  await shoot(page, info, "landing-end");
});

for (const where of ["nav pill", "hero", "final"] as const) {
  test(`the orange call to action in the ${where} opens the wallet page with a full page load`, async ({
    page,
  }) => {
    await open(page);
    let link = page.locator(".l-nav .l-pill");
    if (where === "hero")
      link = page.locator(".l-headline").getByRole("link", { name: "Try it with test coins" });
    if (where === "final") {
      link = page.locator(".l-final").getByRole("link", { name: "Try it with test coins" });
    }
    await expect(link).toHaveAttribute("href", "/vault/new");
  });
}

test('"Live Vault" in the nav opens the live example with a full page load', async ({ page }) => {
  await open(page);
  const link = page.locator(".l-links").getByRole("link", { name: "Live Vault" });
  test.skip(!(await link.isVisible()), "the nav's text links are hidden at this width");
  await expect(link).toHaveAttribute("href", "/vault/176");
});

test("the dive follows layout() and update() at 1440 × 930", async ({ page }, info) => {
  test.skip(isPhone(info), "desktop geometry");
  await open(page);
  const g = layout(1440, 930);
  const motion = { sunUp: false, reduced: false };
  for (const p of [0, 0.4]) {
    await scrollStage(page, p);
    // The browser rounds the scroll offset: compare at the progress it actually reached.
    const reached = await page
      .getByTestId("landing-stage")
      .evaluate((stage: HTMLElement) => window.scrollY / (stage.offsetHeight - window.innerHeight));
    const world = update(g, reached, motion).world;
    const matrix = await page
      .locator(".l-world")
      .evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).toJSON());
    expect(matrix.a, `scale at ${p}`).toBeCloseTo(world.scale, 3);
    expect(Math.abs(matrix.e - world.tx), `tx at ${p}`).toBeLessThanOrEqual(1);
    expect(Math.abs(matrix.f - world.ty), `ty at ${p}`).toBeLessThanOrEqual(1);
  }
  await scrollStage(page, 1);
  const crisp = update(g, 1, motion).crisp;
  const box = await page.getByTestId("landing-crisp").boundingBox();
  if (!box) throw new Error("the crisp copy has no box");
  expect(Math.abs(box.x - crisp.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - crisp.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.width - crisp.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - crisp.height)).toBeLessThanOrEqual(1);
});

test("the laptop shows the desktop product on a phone", async ({ page }, info) => {
  test.skip(!isPhone(info), "phone viewport");
  await open(page);
  await scrollStage(page, 0.5);
  const screen = page.locator(".l-screen");
  await expect(screen.getByTestId("sidebar")).toHaveCSS("display", "flex");
  const tops = await screen
    .getByTestId("stat")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(tops).toHaveLength(4);
  expect(new Set(tops).size).toBe(1);
});

test("a resize mid-dive re-lays the stage out", async ({ page }, info) => {
  test.skip(isPhone(info), "starts at the desktop size");
  await open(page);
  await scrollStage(page, 1);
  await expect(page.getByTestId("landing-crisp")).toHaveAttribute("data-live", "");
  await page.setViewportSize({ width: 390, height: 844 });
  await scrollStage(page, 1);
  const mob = page.getByTestId("landing-mobview");
  await expect(mob).toHaveAttribute("data-live", "");
  await expect(mob).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("landing-crisp")).toHaveCSS("opacity", "0");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the pictured sidebar is decorative: no landmark, no links, no current page", async ({
  page,
}) => {
  await open(page);
  await scrollStage(page, 1);
  await expect(page.getByRole("navigation")).toHaveCount(1);
  await expect(page.locator(".landing [aria-current]")).toHaveCount(0);
  await expect(page.locator(".landing [data-testid=sidebar] a")).toHaveCount(0);
});

test('"Download keys" leads to the real Challenge screen', async ({ page }, info) => {
  await open(page);
  await scrollStage(page, 1);
  await liveProduct(page, info).getByRole("button", { name: "Download keys" }).click();
  await expect(page).toHaveURL(/\/challenge$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
});

test('"Try with these keys" runs one attempt at a time and keeps 0 sats out', async ({
  page,
}, info) => {
  await open(page);
  await scrollStage(page, 1);
  const product = liveProduct(page, info);
  const tryKeys = product.getByRole("button", { name: "Try with these keys" });
  const count = product.getByTestId("attempts-count");
  await expect(count).toHaveText("13");

  // Two quick clicks: one run.
  await tryKeys.click();
  await tryKeys.click();
  await expect(count).toHaveText("14");
  await expect(product.getByTestId("xray-step").first()).toHaveAttribute(
    "data-state",
    /pending|done/,
  );
  const live = page.getByTestId("live-region");
  await expect(live).toHaveText("Illustration: attempt #14 clawed back · 0 sats out", {
    timeout: 6000,
  });
  const steps = product.getByTestId("xray-step");
  await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
  await expect(steps.nth(1)).toHaveAttribute("data-state", "refused");
  await expect(steps.nth(2)).toHaveAttribute("data-state", "ok");
  await expect(steps.nth(3)).toHaveAttribute("data-state", "ok");
  await expect(count).toHaveText("14");

  if (!isPhone(info)) {
    const rows = product.getByTestId("attempt-row");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("#14");
    await expect(rows.first()).toContainText("clawed back · 36 s");
  } else {
    // The log is hidden on phones; the X-Ray and the announcement carry the outcome.
    await expect(product.getByTestId("attempt-log")).toBeHidden();
    await expect(product.getByTestId("xray")).toBeInViewport();
  }

  // A second run: +1 again, and sats never move.
  await tryKeys.click();
  await expect(live).toHaveText(/attempt #15/, { timeout: 6000 });
  await expect(count).toHaveText("15");
  await expect(product).toContainText("attempts · 0 sats out");
  const satsTaken = product.getByTestId("stat").filter({ hasText: "Sats taken" });
  await expect(satsTaken.getByTestId("stat-value")).toHaveText("0");
});

test("every request is same-origin and the video is at most 8,000,000 bytes", async ({ page }) => {
  const requests = await open(page);
  const origin = new URL(page.url()).origin;
  const foreign = requests
    .map((r) => r.url())
    .filter((url) => new URL(url).origin !== origin && !CONFIGURED.has(new URL(url).origin));
  expect(foreign).toEqual([]);

  const src = await page.locator(".l-world video").evaluate((v: HTMLVideoElement) => v.currentSrc);
  expect(src).toMatch(/\/assets\/hero-[\w-]+\.mp4$/);
  expect(new URL(src).origin).toBe(origin);
  const video = await page.request.get(src);
  expect(video.status()).toBe(200);
  expect((await video.body()).length).toBeLessThanOrEqual(MAX_VIDEO_BYTES);

  // Stills and tiles come through <picture>, AVIF first, from hashed assets.
  const scene = page.getByRole("img", { name: /A pale oak desk/ });
  await expect(scene).toHaveJSProperty("complete", true);
  expect(await scene.evaluate((img: HTMLImageElement) => img.currentSrc)).toMatch(
    /\/assets\/hero-[\w-]+\.avif$/,
  );
  expect(await scene.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(5504);
});

// Story 9.5: on a slow connection none of the hero's media may compete with the headline.
test("the hero media waits: the scene after first paint, the gold still and video after the scene", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator(".l-world video")).toHaveJSProperty("readyState", 4, {
    timeout: 15_000,
  });
  const timing = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const pick = (pattern: RegExp) =>
      resources
        .filter((entry) => pattern.test(new URL(entry.name).pathname))
        .map((entry) => ({ start: entry.startTime, end: entry.responseEnd }));
    return {
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      scene: pick(/\/assets\/hero-(?!gold-|poster-)[\w-]+\.avif$/),
      gold: pick(/\/assets\/hero-gold-[\w-]+\.avif$/),
      video: pick(/\/assets\/hero-[\w-]+\.mp4$|\/assets\/hero-poster-/),
    };
  });
  expect(timing.scene).toHaveLength(1);
  const scene = timing.scene[0];
  if (!scene || timing.fcp === null) throw new Error("no scene request or no FCP entry");
  expect(scene.start).toBeGreaterThanOrEqual(timing.fcp);
  expect(timing.gold.length).toBeGreaterThan(0);
  expect(timing.video.length).toBeGreaterThan(0);
  for (const later of [...timing.gold, ...timing.video]) {
    expect(later.start).toBeGreaterThanOrEqual(scene.end);
  }
});

test("a missing video is silent: the still carries the scene", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/assets\/hero-[\w-]+\.mp4$/, (route) => route.fulfill({ status: 404 }));
  await open(page);
  expect(await page.locator(".l-world video").evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe(
    "",
  );
  await expect(page.getByRole("img", { name: /A pale oak desk/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("one h1, one live region, 44 px targets and no sideways scroll", async ({ page }, info) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator("[aria-live]")).toHaveCount(1);
  for (const p of [0, 0.5, 1]) {
    await scrollStage(page, p);
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".landing a, .landing button"))
        // The laptop screen and its copies are drawn scaled; the phone re-flow is not.
        .filter((el) => !el.closest(".l-screen, .l-crisp"))
        .filter((el) => !el.closest("[inert]") && getComputedStyle(el).visibility !== "hidden")
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 1 && rect.height > 1 && rect.bottom > 0)
        .filter(({ rect }) => rect.top < window.innerHeight && rect.height < 44)
        .map(({ el, rect }) => `${el.tagName} "${el.textContent}" ${rect.height}px`),
    );
    expect(small, `at ${p}`).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `at ${p}`).toBeLessThanOrEqual(0);
  }
  if (isPhone(info)) {
    await expect(page.locator(".l-links")).toBeHidden();
    await expect(page.locator(".l-legal")).toBeHidden();
  }
});

test("the feature accordion auto-advances in view and stops for good on a click", async ({
  page,
}) => {
  await page.clock.install();
  await open(page);
  const items = page.locator(".l-fi");
  await expect(items).toHaveCount(5);
  await items.first().scrollIntoViewIfNeeded();
  await expect(items.nth(0)).toHaveAttribute("aria-expanded", "true");
  await expect(items.nth(0).locator(".l-fi-bar")).toHaveAttribute("data-running", "");
  await page.clock.runFor(6100);
  await expect(items.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".l-pv[data-on]")).toHaveCount(1);

  await items.nth(3).click();
  await expect(items.nth(3)).toHaveAttribute("aria-expanded", "true");
  await page.clock.runFor(13_000);
  await expect(items.nth(3)).toHaveAttribute("aria-expanded", "true");
  await expect(items.nth(3).locator(".l-fi-bar")).not.toHaveAttribute("data-running");
});

test("the collage moves with scroll; phones keep three tiles", async ({ page }, info) => {
  await open(page);
  const collage = page.locator(".l-collage");
  const marquee = page.locator(".l-marq");
  const at = async (t: number) => {
    await collage.evaluate((el: HTMLElement, t) => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + (el.offsetHeight - window.innerHeight) * t);
    }, t);
    await settle(page);
    return marquee.evaluate((el) => getComputedStyle(el).transform);
  };
  const start = await at(0.1);
  const later = await at(0.6);
  expect(later).not.toBe(start);
  const visibleTiles = await page.locator(".l-tile:visible").count();
  expect(visibleTiles).toBe(isPhone(info) ? 3 : 7);
  await shoot(page, info, "landing-collage");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no video request, a direct cut, a still collage and accordion", async ({ page }, info) => {
    await page.clock.install();
    const requests = await open(page);
    // No video, and no gold still: it only ever shows while the video plays (story 9.5).
    expect(requests.filter((r) => /\.mp4$|hero-poster|hero-gold/.test(r.url()))).toEqual([]);
    expect(
      await page.locator(".l-world video").evaluate((v: HTMLVideoElement) => v.currentSrc),
    ).toBe("");

    // Just past the start of the dive the product is already there, full size.
    await scrollStage(page, 0.1);
    await expect(liveProduct(page, info)).toHaveCSS("opacity", "1");
    await expect(page.locator(".l-headline")).toHaveCSS("opacity", "0");

    const marquee = page.locator(".l-marq");
    const before = await marquee.evaluate((el) => getComputedStyle(el).transform);
    await page
      .locator(".l-collage")
      .evaluate((el: HTMLElement) => window.scrollTo(0, el.offsetTop + el.offsetHeight / 2));
    await settle(page);
    expect(await marquee.evaluate((el) => getComputedStyle(el).transform)).toBe(before);

    const items = page.locator(".l-fi");
    await items.first().scrollIntoViewIfNeeded();
    await page.clock.runFor(13_000);
    await expect(items.nth(0)).toHaveAttribute("aria-expanded", "true");
    await expect(items.nth(0).locator(".l-fi-bar")).toHaveCSS("animation-name", "none");
  });
});

test.describe("side by side with the approved mockup", () => {
  const mockup = findMockup();

  test("the dive matches the mockup at 0, 40 and 100 %", async ({ page, browser }, info) => {
    test.skip(mockup === null, "the mockup (_bmad-output) is not on disk");
    if (mockup === null) return;
    const reference = await browser.newPage({ viewport: page.viewportSize() });
    // The mockup asks Google for its fonts; the comparison is geometry, so leave them out.
    await reference.route(/^https?:\/\/fonts\./, (route) => route.abort());
    await reference.goto(pathToFileURL(mockup).href);
    await open(page);

    for (const p of [0, 0.4, 1]) {
      await scrollStage(page, p);
      await scrollStage(reference, p, "#scroll");
      const ours = await page.evaluate(() => {
        const q = (s: string) => {
          const el = document.querySelector<HTMLElement>(s);
          if (!el) throw new Error(`no ${s}`);
          return el;
        };
        const rect = (s: string) => q(s).getBoundingClientRect().toJSON() as DOMRect;
        return {
          world: getComputedStyle(q(".l-world")).transform,
          crisp: rect("[data-testid=landing-crisp]"),
          crispOpacity: Number(getComputedStyle(q("[data-testid=landing-crisp]")).opacity),
          mobOpacity: Number(getComputedStyle(q("[data-testid=landing-mobview]")).opacity),
          headline: Number(getComputedStyle(q(".l-headline")).opacity),
          headlineTop: rect(".l-headline").top,
          solid: q(".l-nav").hasAttribute("data-solid"),
        };
      });
      const theirs = await reference.evaluate(() => {
        const q = (s: string) => {
          const el = document.querySelector<HTMLElement>(s);
          if (!el) throw new Error(`no ${s}`);
          return el;
        };
        const rect = (s: string) => q(s).getBoundingClientRect().toJSON() as DOMRect;
        return {
          world: getComputedStyle(q("#world")).transform,
          crisp: rect("#crisp"),
          crispOpacity: Number(getComputedStyle(q("#crisp")).opacity),
          mobOpacity: Number(getComputedStyle(q("#mobview")).opacity),
          headline: Number(getComputedStyle(q("#hl")).opacity),
          headlineTop: rect("#hl").top,
          solid: q("#nav").classList.contains("solid"),
        };
      });
      expect(ours.world, `world at ${p}`).toBe(theirs.world);
      for (const key of ["x", "y", "width", "height"] as const) {
        expect(ours.crisp[key], `crisp ${key} at ${p}`).toBeCloseTo(theirs.crisp[key], 1);
      }
      expect(ours.crispOpacity, `crisp opacity at ${p}`).toBeCloseTo(theirs.crispOpacity, 3);
      expect(ours.mobOpacity, `phone view opacity at ${p}`).toBeCloseTo(theirs.mobOpacity, 3);
      expect(ours.headline, `headline at ${p}`).toBeCloseTo(theirs.headline, 3);
      expect(ours.headlineTop, `headline top at ${p}`).toBeCloseTo(theirs.headlineTop, 0);
      expect(ours.solid, `nav at ${p}`).toBe(theirs.solid);

      const name = `compare-${Math.round(p * 100)}`;
      await shoot(page, info, `${name}-build`);
      const path = info.outputPath(`${name}-mockup.png`);
      await reference.screenshot({ path });
      await info.attach(`${name}-mockup`, { path, contentType: "image/png" });
    }
    await reference.close();
  });
});
