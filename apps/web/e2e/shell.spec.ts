import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

const NAV_ROUTES = ["/vault", "/challenge", "/guardians", "/policy", "/proof", "/x-ray"];
const ROUTES = [...NAV_ROUTES, "/g/7/clawback", "/nope"];
const NAV_LABELS = ["Vault", "Challenge", "Guardians", "Policy", "Proof", "X-Ray"];

const INK = "rgb(243, 241, 236)";
const ORANGE = "rgb(255, 122, 26)";
const OK = "rgb(126, 226, 168)";

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

      const foreign = requests.map((r) => r.url()).filter((url) => new URL(url).origin !== origin);
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

test("/ redirects to /challenge", async ({ page }) => {
  await open(page, "/");
  await expect(page).toHaveURL(/\/challenge$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
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

test("/challenge matches the mockup's desktop product screen", async ({ page }, info) => {
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
  await expect(sidebar).toContainText("signet · NEAR testnet");
  await expect(sidebar).toContainText("contract locked");
  await expect(sidebar).toContainText("co-signer v1.signer");
  await expect(page.getByTestId("system-dot")).toHaveCSS("background-color", OK);
  await expect(page.getByTestId("phone-bar")).toBeHidden();

  expect(await orangeElements(page)).toBe(1);
  await expect(page.getByRole("button", { name: "Try with these keys" })).toHaveCSS(
    "background-color",
    ORANGE,
  );

  const hero = page.getByTestId("hero");
  const heroColumns = await hero.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(heroColumns.split(" ")).toHaveLength(2);

  const stats = page.getByTestId("stat");
  await expect(stats).toHaveCount(4);
  const tops = await stats.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);

  const fonts = await page.evaluate(() => {
    const family = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : "");
    return {
      heading: family(document.querySelector("h1")),
      numeral: family(document.querySelector("[data-testid=hero] .text-numeral-hero")),
      stat: family(document.querySelector("[data-testid=stat] .text-numeral")),
      nav: family(document.querySelector("[data-testid=sidebar] a")),
      button: family(document.querySelector("button")),
      loaded: [
        document.fonts.check('500 26px "Funnel Display"'),
        document.fonts.check('300 92px "Funnel Display"'),
        document.fonts.check('400 15px "Funnel Sans"'),
        document.fonts.check('600 14px "Funnel Sans"'),
        document.fonts.check('400 12px "Geist Mono"'),
      ],
    };
  });
  expect(fonts.heading).toMatch(/^"Funnel Display"/);
  expect(fonts.numeral).toMatch(/^"Funnel Display"/);
  expect(fonts.stat).toMatch(/^"Funnel Display"/);
  expect(fonts.nav).toMatch(/^"Funnel Sans"/);
  expect(fonts.button).toMatch(/^"Funnel Sans"/);
  expect(fonts.loaded).toEqual([true, true, true, true, true]);
});

test("/challenge shows the mockup's values", async ({ page }) => {
  await open(page, "/challenge");
  const header = page.locator("main header");
  await expect(header.locator("[data-slot=badge]")).toHaveText(["round 7", "keys published"]);

  const hero = page.getByTestId("hero");
  await expect(hero.locator(".text-numeral-hero")).toHaveText(/^06:12/);
  await expect(hero.locator(".text-numeral-hero")).toContainText("tomorrow");
  await expect(hero.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "21");
  await expect(hero).toContainText("Requested yesterday, 06:12");
  await expect(hero).toContainText("18 h 59 m left");
  await expect(page.getByTestId("attempts-count")).toHaveText("13");
  await expect(hero).toContainText("attempts · 0 sats out");
  await expect(hero).toContainText("Round 7 · last 24 h");
  await expect(hero).toContainText("Last attempt 03:11");

  const stats = page.getByTestId("stat");
  await expect(stats.locator("[data-testid=stat-value]")).toHaveText([
    "0.01000000",
    "24 h",
    "0",
    "11/16",
  ]);
  await expect(stats.nth(0)).toContainText("Held in vault");
  await expect(stats.nth(0).locator("small")).toHaveText("sBTC");
  await expect(stats.nth(1)).toContainText("Delay");
  await expect(stats.nth(1).locator("small")).toHaveText("per withdrawal");
  await expect(stats.nth(2)).toContainText("Sats taken");
  await expect(stats.nth(2).locator("[data-testid=stat-value]")).toHaveCSS("color", OK);
  await expect(stats.nth(3)).toContainText("Co-signer");
});

test("/challenge re-flows on a phone", async ({ page }, info) => {
  test.skip(!isPhone(info.project.name), "phone layout");
  await open(page, "/challenge");

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

  const header = await box(page.locator("main header"));
  const primary = await box(page.getByRole("button", { name: "Try with these keys" }));
  expect(Math.round(primary.width)).toBe(Math.round(header.width));
  expect(await orangeElements(page)).toBe(1);
});

test("other nav routes show the shell, a title and skeletons, without a primary action", async ({
  page,
}, info) => {
  const pages: [string, string][] = [
    ["/vault", "Vault"],
    ["/guardians", "Guardians"],
    ["/policy", "Policy"],
    ["/proof", "Proof"],
    ["/x-ray", "X-Ray"],
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
    ? ["Skip to content", "Open menu", "Download keys", "Try with these keys"]
    : ["Skip to content", ...NAV_LABELS, "Download keys", "Try with these keys"];

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
  await open(page, "/challenge");
  const fades = await page
    .locator(".animate-fade-in")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  expect(fades.length).toBeGreaterThan(0);
  expect(new Set(fades)).toEqual(new Set(["none"]));

  await open(page, "/vault");
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
