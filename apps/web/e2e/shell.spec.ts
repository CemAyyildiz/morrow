import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { BACKEND_URL, RPC_URL, WATCHER_URL } from "./services.ts";

const NAV_ROUTES = ["/vault", "/challenge", "/guardians", "/policy", "/proof", "/xray"];
const ROUTES = [...NAV_ROUTES, "/proof/7", "/xray/7", "/g/7/clawback", "/nope"];
const NAV_LABELS = ["Vault", "Challenge", "Guardians", "Policy", "Proof", "X-Ray"];

const INK = "rgb(243, 241, 236)";
const ORANGE = "rgb(255, 122, 26)";
const OK = "rgb(126, 226, 168)";

/** The only origins besides the page's own that the CSP lets it reach. */
const CONFIGURED = new Set([RPC_URL, BACKEND_URL, WATCHER_URL].map((url) => new URL(url).origin));

const isPhone = (projectName: string) => projectName === "phone";

/** The element's box; fails the test when it is not rendered. */
async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${locator.toString()} has no box`);
  return rect;
}

/** Opens a route, records every request, and waits for the page and its fonts to settle. */
async function open(page: Page, path: string): Promise<Request[]> {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return requests;
}

/** Elements with a computed orange background that are on screen. */
function orangeElements(page: Page) {
  return page.evaluate(
    (orange) =>
      Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).backgroundColor === orange;
      }).length,
    ORANGE,
  );
}

test.describe("every route", () => {
  for (const path of ROUTES) {
    test(`${path}: same-origin only, banner, 44 px targets, no sideways scroll`, async ({
      page,
    }) => {
      const requests = await open(page, path);
      const origin = new URL(page.url()).origin;

      // No third-party request: only the page's origin and the three configured services.
      const foreign = requests
        .map((r) => r.url())
        .filter((url) => new URL(url).origin !== origin && !CONFIGURED.has(new URL(url).origin));
      expect(foreign).toEqual([]);

      const fonts = requests.filter((r) => r.resourceType() === "font");
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) expect(new URL(font.url()).origin).toBe(origin);

      await expect(page.getByTestId("testnet-banner")).toBeVisible();
      await expect(page.getByTestId("testnet-banner")).toHaveText(
        "Signet test coins · NEAR testnet · not real bitcoin",
      );

      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("a, button"))
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          // Visually hidden elements (the skip link until focused) are 1 x 1 px.
          .filter(({ rect }) => rect.width > 1 && rect.height > 1)
          .filter(({ rect }) => rect.height < 44)
          .map(({ el, rect }) => `${el.tagName} "${el.textContent}" ${rect.height}px`),
      );
      expect(small).toEqual([]);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);

      // The live region exists exactly once.
      await expect(page.locator("[aria-live]")).toHaveCount(1);
    });
  }
});

test("/ is the landing, full-bleed outside the shell", async ({ page }) => {
  await open(page, "/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle("morrow · Bitcoin that can't be rushed");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bitcoin that can't be rushed.");
  // No shell chrome: the product appears only inside the hero laptop.
  await expect(page.getByTestId("phone-bar")).toHaveCount(0);
  await expect(page.getByTestId("testnet-banner")).toHaveCount(0);
  await expect(page.locator("#main")).toHaveCount(0);
});

test("the markup carries no inline script or style", async ({ page }) => {
  const response = await page.request.get("/challenge");
  const html = await response.text();
  expect(html).not.toMatch(/<script>|<script(?![^>]*\bsrc=)[^>]*>|style="|<style|data:/);

  await open(page, "/challenge");
  const styled = await page.evaluate(
    () => document.querySelectorAll("[style]").length + document.querySelectorAll("style").length,
  );
  expect(styled).toBe(0);
  await expect(page.locator("html")).toHaveAttribute("class", /\bdark\b/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("the desktop shell matches the mockup", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "desktop layout");
  await open(page, "/challenge");

  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toBeVisible();
  expect((await box(sidebar)).width).toBe(232);
  await expect(sidebar.getByRole("link")).toHaveText(NAV_LABELS.map((l) => new RegExp(`^${l}`)));
  await expect(sidebar.getByRole("link", { name: /Challenge/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("phone-bar")).toBeHidden();

  const fonts = await page.evaluate(() => {
    const family = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : "");
    return {
      heading: family(document.querySelector("h1")),
      nav: family(document.querySelector("[data-testid=sidebar] a")),
      system: family(document.querySelector("[data-testid=system-card]")),
      loaded: [
        document.fonts.check('500 26px "Funnel Display"'),
        document.fonts.check('400 22px "Funnel Display"'),
        document.fonts.check('400 15px "Funnel Sans"'),
        document.fonts.check('400 12px "Geist Mono"'),
      ],
    };
  });
  expect(fonts.heading).toMatch(/^"Funnel Display"/);
  expect(fonts.nav).toMatch(/^"Funnel Sans"/);
  expect(fonts.system).toMatch(/^"Geist Mono"/);
  expect(fonts.loaded).toEqual([true, true, true, true]);

  await open(page, "/vault");
  const hero = page.getByTestId("hero");
  const heroColumns = await hero.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(heroColumns.split(" ")).toHaveLength(2);
  const stats = page.getByTestId("stat");
  await expect(stats).toHaveCount(4);
  const tops = await stats.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
});

test("the system card shows the live config, lock state and heartbeat", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "the system card lives in the sidebar");
  await open(page, "/challenge");
  const card = page.getByTestId("system-card");
  await expect(card).toContainText("signet · NEAR testnet");
  await expect(card).toContainText("contract locked");
  await expect(card).toContainText("co-signer v1.signer-prod.testnet");
  await expect(page.getByTestId("system-alerts")).toHaveText("Alerts: watcher last seen 1 min ago");
  await expect(page.getByTestId("system-alerts")).toHaveAttribute("data-alarm", "false");
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", OK);
});

test("product tabs keep their titles", async ({ page }) => {
  await open(page, "/challenge");
  await expect(page).toHaveTitle("Challenge vault · morrow");
  await open(page, "/nope");
  await expect(page).toHaveTitle("Not found · morrow");
});

test("/challenge shows the honest empty state in production", async ({ page }) => {
  await open(page, "/challenge");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
  const empty = page.getByTestId("challenge-empty");
  await expect(empty).toBeVisible();
  await expect(empty.getByRole("heading", { level: 2 })).toHaveText("No round is open yet");
  // No sample values, no round chips, no actions without a round.
  await expect(page.getByTestId("hero")).toHaveCount(0);
  await expect(page.getByTestId("stat")).toHaveCount(0);
  await expect(page.locator("main header [data-slot=badge]")).toHaveCount(0);
  await expect(page.getByTestId("header-actions")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/06:12|18 h 59 m|round 7|0\.01000000/);
  expect(await orangeElements(page)).toBe(0);
});

test("the shell re-flows on a phone", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone layout");
  await open(page, "/vault");

  await expect(page.getByTestId("sidebar")).toBeHidden();
  await expect(page.getByTestId("phone-bar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

  const heroColumns = await page
    .getByTestId("hero")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(heroColumns.split(" ")).toHaveLength(1);

  const boxes = await page
    .getByTestId("stat")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(boxes).toHaveLength(4);
  expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(2);
  expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(2);

  await open(page, "/challenge");
  const header = await box(page.locator("main header"));
  const empty = await box(page.getByTestId("challenge-empty"));
  expect(Math.round(empty.width)).toBe(Math.round(header.width));
});

test("other nav routes show the shell, a title and skeletons, without a primary action", async ({
  page,
}, info) => {
  const pages: [string, string][] = [
    ["/vault", "Vault"],
    ["/guardians", "Guardians"],
    ["/policy", "Policy"],
  ];
  for (const [path, title] of pages) {
    await open(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    expect(await page.locator("[data-slot=skeleton]").count()).toBeGreaterThan(4);
    expect(await orangeElements(page)).toBe(0);
    if (!isPhone(info.project.name)) {
      await expect(page.getByTestId("sidebar").locator("[aria-current=page]")).toHaveText(title);
    }
  }
});

test("X-Ray: /x-ray leads to the form, an op id opens /xray/<id>, canonical", async ({
  page,
}, info) => {
  await open(page, "/x-ray");
  await expect(page).toHaveURL(/\/xray$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("X-Ray");
  if (!isPhone(info.project.name)) {
    await expect(page.getByTestId("sidebar").locator("[aria-current=page]")).toHaveText("X-Ray");
  }
  const form = page.getByTestId("xray-open");
  await form.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("xray-open-error")).toBeVisible();
  await page.getByTestId("xray-open-input").fill("0025");
  await form.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/xray\/25$/);
  await expect(page.locator("main header [data-slot=badge]")).toHaveText("op #25");

  // `/xray/007` is op 7: the address bar becomes `/xray/7`.
  await open(page, "/xray/007");
  await expect(page).toHaveURL(/\/xray\/7$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("X-Ray");
  // The stub RPC has no get_op: the read fails and says so, with Retry.
  await expect(page.getByTestId("xray-unreachable")).toBeVisible({ timeout: 20_000 });

  const hash = "2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD";
  await open(page, `/xray/tx/${hash}`);
  await expect(page).toHaveURL(new RegExp(`/xray/tx/${hash}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("X-Ray");
  await expect(page.locator("main header [data-slot=badge]")).toHaveText("refused call");
});

test("unknown routes show a Not found card linking to /challenge", async ({ page }) => {
  for (const path of ["/g/7/clawback", "/nope"]) {
    await open(page, path);
    const card = page.getByTestId("not-found");
    await expect(card).toBeVisible();
    await expect(card).toContainText(path);
    await card.getByRole("link", { name: "Open Challenge" }).click();
    await expect(page).toHaveURL(/\/challenge$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
  }
});

test("Tab shows the focus ring through the nav and the header", async ({ page }, info) => {
  await open(page, "/challenge");
  const expected = isPhone(info.project.name)
    ? ["Skip to content", "Open menu"]
    : ["Skip to content", ...NAV_LABELS];

  const seen: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press("Tab");
    const focus = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const style = getComputedStyle(el);
        return {
          name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/live$/, "").trim(),
          visible: el.matches(":focus-visible"),
          outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        };
      });
    // `transition-colors` eases the ring's color in; wait for it to settle.
    await expect
      .poll(async () => {
        const { visible, outline } = await focus();
        return { visible, outline };
      })
      .toEqual({ visible: true, outline: `solid 2px ${INK}` });
    seen.push((await focus()).name);
  }
  expect(seen).toEqual(expected);
});

test("the skip link is first and moves focus to main", async ({ page }) => {
  await open(page, "/challenge");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  expect((await box(skip)).height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
  await expect(page).toHaveURL(/\/challenge$/);
});

test("a long unknown path does not scroll sideways", async ({ page }) => {
  const path = `/${"a-very-long-unknown-path-segment".repeat(8)}`;
  await open(page, path);
  await expect(page.getByTestId("not-found")).toContainText("a-very-long");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the phone menu opens, traps focus, locks scroll and closes", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone menu");
  await open(page, "/challenge");
  const menuButton = page.getByRole("button", { name: "Open menu" });
  const dialog = page.getByRole("dialog", { name: "Menu" });

  // Esc closes and returns focus to the button.
  await menuButton.click();
  await expect(dialog).toBeVisible();
  expect((await box(dialog)).height).toBe(844);
  await expect(dialog.getByRole("link")).toHaveText(NAV_LABELS.map((l) => new RegExp(`^${l}`)));
  for (const link of await dialog.getByRole("link").all()) {
    expect((await box(link)).height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("button", { name: "Close menu" })).toBeFocused();
  await expect(page.locator("html")).toHaveClass(/\bscroll-locked\b/);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    "hidden",
  );

  // Focus stays inside the panel, both ways, and after a tap on blank panel space.
  for (let i = 0; i < 9; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.getByRole("button", { name: "Close menu" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("link", { name: "X-Ray" })).toBeFocused();
  await page.mouse.click(195, 700);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  // The page behind is inert.
  for (const id of ["testnet-banner", "phone-bar"]) {
    expect(await page.getByTestId(id).evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
  }
  expect(await page.locator("main").evaluate((el) => el.closest("[inert]") !== null)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(menuButton).toBeFocused();
  await expect(page.locator("html")).not.toHaveClass(/\bscroll-locked\b/);

  // The close button closes.
  await menuButton.click();
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(dialog).toBeHidden();
  await expect(menuButton).toBeFocused();

  // Choosing an item navigates and closes.
  await menuButton.click();
  await dialog.getByRole("link", { name: "Guardians" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/guardians$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Guardians");
  await expect(menuButton).toBeFocused();
  expect(await page.locator("main").evaluate((el) => el.closest("[inert]") !== null)).toBe(false);
  await expect(menuButton).not.toHaveAttribute("aria-controls");

  // Browser Back closes the menu and unlocks scroll.
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-controls", "phone-menu");
  await page.goBack();
  await expect(page).toHaveURL(/\/challenge$/);
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).not.toHaveClass(/\bscroll-locked\b/);
  await expect(page.locator("main#main")).toBeFocused();

  // Widening to the desktop layout closes the menu and focuses main, not the hidden button.
  await menuButton.click();
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 930 });
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).not.toHaveClass(/\bscroll-locked\b/);
  await expect(page.locator("main#main")).toBeFocused();
});

test("reduced motion stops the shimmer and the number fade-in", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "/vault");
  // Production has no round, so no number fades in yet: probe the rule with a stand-in.
  const fade = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "animate-fade-in";
    document.body.append(probe);
    const name = getComputedStyle(probe).animationName;
    probe.remove();
    return name;
  });
  expect(fade).toBe("none");

  const shimmers = await page
    .locator("[data-slot=skeleton]")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  expect(shimmers.length).toBeGreaterThan(0);
  expect(new Set(shimmers)).toEqual(new Set(["none"]));

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const moving = await page
    .locator("[data-slot=skeleton]")
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(moving).toBe("shimmer");
});

test("nav links navigate in place and Back returns", async ({ page }, info) => {
  test.skip(isPhone(info.project.name), "sidebar navigation");
  await open(page, "/challenge");
  const liveRegion = page.getByTestId("live-region");
  await expect(liveRegion).toHaveText("");
  const sidebar = page.getByTestId("sidebar");

  // Re-choosing the current page adds no history entry.
  const before = await page.evaluate(() => history.length);
  await sidebar.getByRole("link", { name: /Challenge/ }).click();
  expect(await page.evaluate(() => history.length)).toBe(before);

  await sidebar.getByRole("link", { name: "Proof" }).click();
  await expect(page).toHaveURL(/\/proof$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Proof");
  await expect(liveRegion).toHaveText("Proof");
  await expect(page.locator("main#main")).toBeFocused();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
  await expect(liveRegion).toHaveText("Challenge vault");
  await expect(page.locator("main#main")).toBeFocused();
});
