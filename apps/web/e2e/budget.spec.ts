import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { BACKEND_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// Story 9.5: a Lighthouse-style budget for the public site, against the production build the
// e2e run serves. Bytes are read from dist/; LCP and CLS come from the browser's own entries
// on Lighthouse's mobile "Slow 4G" profile, applied through DevTools: 562.5 ms round trip,
// 1.47 Mbps down, 675 kbps up, 4x CPU slowdown.

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const KB = 1024;

/** Gzip sizes at most (Vite's report uses the same measure); about 10 % above today's. */
const BUDGET = {
  entryJs: 175 * KB,
  css: 14 * KB,
  /** All self-hosted woff2 files together. */
  fonts: 130 * KB,
  /** The hero scene still, the LCP-critical image on the landing. */
  heroAvif: 600 * KB,
  /** The main bundle as the server sends it (brotli). */
  entryOnTheWire: 150 * KB,
};

const LCP_MS = 2500;
const CLS = 0.1;

const SLOW_4G = {
  offline: false,
  latency: 562.5,
  downloadThroughput: (1474.56 * KB) / 8,
  uploadThroughput: (675 * KB) / 8,
};
const CPU_SLOWDOWN = 4;

const PUBLIC_PAGES = ["/", "/challenge", "/proof", "/xray", "/lost"];
const CONFIGURED = new Set([RPC_URL, BACKEND_URL, WATCHER_URL].map((url) => new URL(url).origin));

const index = () => readFileSync(`${DIST}index.html`, "utf8");
const gzipSize = (file: string) => gzipSync(readFileSync(`${DIST}${file}`), { level: 9 }).length;
const assets = () => readdirSync(`${DIST}assets`);

function entryScript(): string {
  const src = /<script type="module"[^>]*src="\/([^"]+\.js)"/.exec(index())?.[1];
  if (!src) throw new Error("dist/index.html has no module script");
  return src;
}

test.describe("bundle budget", () => {
  test("the entry script, the stylesheet, the fonts and the hero still stay within budget", () => {
    expect(gzipSize(entryScript())).toBeLessThanOrEqual(BUDGET.entryJs);
    const css = [...index().matchAll(/<link rel="stylesheet"[^>]*href="\/([^"]+\.css)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(css).toHaveLength(1);
    expect(gzipSize(css[0] ?? "")).toBeLessThanOrEqual(BUDGET.css);

    const fonts = assets().filter((file) => file.endsWith(".woff2"));
    const fontBytes = fonts.reduce(
      (sum, file) => sum + readFileSync(`${DIST}assets/${file}`).length,
      0,
    );
    expect(fontBytes).toBeLessThanOrEqual(BUDGET.fonts);

    const hero = assets().find((file) => /^hero-[\w-]+\.avif$/.test(file));
    expect(hero).toBeDefined();
    expect(readFileSync(`${DIST}assets/${hero}`).length).toBeLessThanOrEqual(BUDGET.heroAvif);
  });

  test("the HTML asks for /config.json beside the bundle", () => {
    expect(index()).toMatch(
      /<link rel="preload" href="\/config\.json" as="fetch" crossorigin="anonymous">/,
    );
  });

  test("the server sends the bundle brotli encoded", async ({ request }) => {
    const response = await request.get(`/${entryScript()}`, {
      headers: { "accept-encoding": "br" },
    });
    expect(response.headers()["content-encoding"]).toBe("br");
    const length = Number(response.headers()["content-length"]);
    expect(length).toBeGreaterThan(0);
    expect(length).toBeLessThanOrEqual(BUDGET.entryOnTheWire);
  });
});

/** Opens `path` on the Slow 4G profile and reads LCP and CLS once it has loaded. */
async function throttledVitals(page: Page, path: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", SLOW_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  await page.addInitScript(() => {
    const vitals = { lcp: 0, cls: 0 };
    (window as unknown as { __vitals: typeof vitals }).__vitals = vitals;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcp = entry.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) vitals.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(path, { waitUntil: "load", timeout: 60_000 });
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 30_000 });
  // Let the late layout settle (fonts, the hero still) before reading the totals.
  await page.waitForTimeout(1500);
  return page.evaluate(
    () => (window as unknown as { __vitals: { lcp: number; cls: number } }).__vitals,
  );
}

test.describe("Slow 4G vitals", () => {
  for (const path of ["/", "/challenge"]) {
    test(`${path}: LCP ≤ ${LCP_MS} ms and CLS ≤ ${CLS}`, async ({ page }) => {
      test.slow();
      const vitals = await throttledVitals(page, path);
      test.info().annotations.push({
        type: "vitals",
        description: `LCP ${Math.round(vitals.lcp)} ms, CLS ${vitals.cls.toFixed(3)}`,
      });
      console.log(
        `${path} [${test.info().project.name}] LCP ${Math.round(vitals.lcp)} ms, CLS ${vitals.cls.toFixed(3)}`,
      );
      expect(vitals.lcp).toBeGreaterThan(0);
      expect(vitals.lcp).toBeLessThanOrEqual(LCP_MS);
      expect(vitals.cls).toBeLessThanOrEqual(CLS);
    });
  }
});

for (const path of PUBLIC_PAGES) {
  test(`${path}: no request leaves the page's origin and the configured services`, async ({
    page,
  }) => {
    const urls: string[] = [];
    page.on("request", (request) => urls.push(request.url()));
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const origin = new URL(page.url()).origin;
    const foreign = urls.filter((url) => {
      const { origin: from, protocol } = new URL(url);
      return protocol.startsWith("http") && from !== origin && !CONFIGURED.has(from);
    });
    expect(foreign).toEqual([]);
  });
}
