import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Story 9.5: the public pages against the production build, at the desktop and phone sizes.
// axe-core (the engine behind Lighthouse's accessibility score) must find nothing at WCAG 2.2
// A/AA or in its best practices; every image carries alt text; Tab never lands on an element
// without a visible focus indicator.

const PUBLIC_PAGES = ["/", "/challenge", "/proof", "/xray", "/lost"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const isPhone = (info: TestInfo) => info.project.name === "phone";

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator("h1").first()).toBeVisible();
}

/** axe's violations as `rule: selector` lines, so a failure names what to fix. */
async function violations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return violations.flatMap((v) => v.nodes.map((node) => `${v.id}: ${node.target.join(" ")}`));
}

/** The landing scrolled to the product end of the dive, where the live product takes over. */
async function scrollToProduct(page: Page) {
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>("[data-testid=landing-stage]");
    if (!stage) throw new Error("no landing stage");
    const top = stage.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + (stage.offsetHeight - window.innerHeight) * 0.95);
  });
  await expect(page.locator(".l-nav")).toHaveAttribute("data-solid", "");
}

for (const path of PUBLIC_PAGES) {
  test(`${path}: axe finds no violation`, async ({ page }) => {
    await open(page, path);
    expect(await violations(page)).toEqual([]);
  });

  test(`${path}: every image has alt text`, async ({ page }) => {
    await open(page, path);
    const images = await page.locator("img").evaluateAll((all) =>
      all.map((img) => ({
        alt: img.getAttribute("alt"),
        src: img.getAttribute("src") ?? "",
        hidden: img.closest("[aria-hidden=true]") !== null,
      })),
    );
    for (const image of images) {
      expect(image.alt, image.src).not.toBeNull();
      // An empty alt is for decoration, which assistive technology must not reach anyway.
      if (image.alt === "")
        expect(image.hidden, `${image.src} has alt="" but is exposed`).toBe(true);
    }
  });
}

test("/: the hero scene is described once it loads", async ({ page }) => {
  await open(page, "/");
  const scene = page.locator(".l-world img").first();
  await expect(scene).toHaveAttribute("src", /\/assets\/hero-/);
  await expect(scene).toHaveAttribute("alt", /\S/);
});

test("/: axe finds no violation at the product end of the dive, nav solid", async ({ page }) => {
  await open(page, "/");
  await scrollToProduct(page);
  expect(await violations(page)).toEqual([]);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("/: axe finds no violation", async ({ page }) => {
    await open(page, "/");
    expect(await violations(page)).toEqual([]);
  });
});

/**
 * Tabs through the page from the top, up to `max` stops or until focus leaves the document,
 * and returns each focused element with whether it shows a focus indicator.
 */
async function tabStops(page: Page, max: number) {
  const stops: { name: string; visible: boolean }[] = [];
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const ring =
        (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== "none";
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`;
      return { name, visible: ring };
    });
    if (stop === null) break;
    stops.push(stop);
  }
  return stops;
}

test("/: Tab starts at the nav in reading order, every stop with a focus ring", async ({
  page,
}, info) => {
  await open(page, "/");
  const stops = await tabStops(page, 60);
  const names = stops.map((stop) => stop.name);
  // The nav comes first: the wordmark, then (desktop only) the links, then the orange pill.
  expect(names[0]).toBe('a "morrow"');
  const firstHeadlineLink = names.findIndex((name) => name.includes("Read the proof"));
  expect(firstHeadlineLink).toBeGreaterThan(isPhone(info) ? 0 : 4);
  expect(stops.filter((stop) => !stop.visible).map((stop) => stop.name)).toEqual([]);
  expect(stops.length).toBeGreaterThan(5);
});

for (const path of ["/challenge", "/proof", "/xray", "/lost"]) {
  test(`${path}: the skip link comes first and every Tab stop shows a focus ring`, async ({
    page,
  }) => {
    await open(page, path);
    const stops = await tabStops(page, 40);
    expect(stops[0]?.name).toBe('a "Skip to content"');
    expect(stops.filter((stop) => !stop.visible).map((stop) => stop.name)).toEqual([]);
  });
}
