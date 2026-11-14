import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Story 9.2: the three-beat story and the doors, straight after the hero dive, against the
// production build at the mockup's desktop size and at a phone size.

const SOURCES = [
  ["Time lock, Wikipedia", "https://en.wikipedia.org/wiki/Time_lock"],
  ["BIP-345 withdrawal, bitcoin/bips #1848", "https://github.com/bitcoin/bips/pull/1848"],
  [
    "Chain Signatures, NEAR documentation",
    "https://docs.near.org/chain-abstraction/chain-signatures",
  ],
] as const;

const isPhone = (info: TestInfo) => info.project.name === "phone";

/** Opens the landing with a CSP violation recorder armed before any script runs. */
async function open(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const story = (page: Page) => page.getByTestId("landing-story");

test("the story follows the hero, before the feature list", async ({ page }) => {
  await open(page);
  const order = await page.evaluate(() => {
    const main = document.querySelector("main");
    return Array.from(main?.children ?? []).map((el) => el.getAttribute("data-testid") ?? el.id);
  });
  expect(order.slice(0, 3)).toEqual(["landing-stage", "landing-story", "why"]);

  await story(page).scrollIntoViewIfNeeded();
  await expect(story(page)).toBeInViewport();
  const heading = story(page).getByRole("heading", { level: 2 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveText("Bitcoin has time locks. It never had a time-lock safe.");
  await expect(story(page).locator("ol > li")).toHaveCount(3);
  await expect(story(page).locator(".l-era")).toHaveText(["1870s", "2025", "Today"]);
  await expect(story(page).locator(".l-era").first()).toHaveCSS("font-family", /Funnel Display/);
  await expect(story(page).locator("[style]")).toHaveCount(0);
});

test("each beat links its source in a new tab", async ({ page }) => {
  await open(page);
  for (const [label, href] of SOURCES) {
    const link = story(page).getByRole("link", {
      name: `${label} (opens in a new tab)`,
      exact: true,
    });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(story(page).locator("ol a")).toHaveCount(SOURCES.length);
});

test("the doors: Try it with test coins, Watch a live Vault, Read the proof", async ({ page }) => {
  await open(page);
  const doors = page.getByTestId("story-doors");
  await expect(doors.getByRole("link")).toHaveCount(3);
  await expect(doors.getByRole("link", { name: /^Try it with test coins/ })).toHaveAttribute(
    "href",
    "/vault/new",
  );
  await expect(doors.getByRole("link", { name: /^Read the proof/ })).toHaveAttribute(
    "href",
    "/proof",
  );
  await expect(doors.getByRole("link", { name: /^Watch a live Vault/ })).toHaveAttribute(
    "href",
    "/vault/176",
  );
});

test('the "Read the proof" door opens the Proof Page in place', async ({ page }) => {
  await open(page);
  await page
    .getByTestId("story-doors")
    .getByRole("link", { name: /^Read the proof/ })
    .click();
  await expect(page).toHaveURL(/\/proof$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Proof");
});

test("three columns on desktop, one on phones; doors full width on phones", async ({
  page,
}, info) => {
  await open(page);
  await story(page).scrollIntoViewIfNeeded();
  const beats = await page
    .getByTestId("story-beat")
    // Layout boxes, not painted ones: the fade-in translates beats while it runs.
    .evaluateAll((els: HTMLElement[]) =>
      els.map((el) => ({
        x: el.offsetLeft,
        y: el.offsetTop,
        width: el.offsetWidth,
        right: el.offsetLeft + el.offsetWidth,
        bottom: el.offsetTop + el.offsetHeight,
        left: el.offsetLeft,
        top: el.offsetTop,
      })),
    );
  const [first, second, third] = beats;
  if (!first || !second || !third || beats.length !== 3) throw new Error("expected 3 beats");
  if (isPhone(info)) {
    expect(new Set(beats.map((b) => Math.round(b.x))).size).toBe(1);
    expect(first.bottom).toBeLessThanOrEqual(second.top);
    expect(second.bottom).toBeLessThanOrEqual(third.top);
    const door = await page.locator(".l-door").first().boundingBox();
    if (!door) throw new Error("no door");
    expect(Math.abs(door.width - first.width)).toBeLessThanOrEqual(1);
  } else {
    expect(new Set(beats.map((b) => Math.round(b.y))).size).toBe(1);
    expect(first.right).toBeLessThanOrEqual(second.left);
    expect(second.right).toBeLessThanOrEqual(third.left);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Once every beat has faded in: the doors sit below all beats, starting under the first.
  for (const beat of await page.getByTestId("story-beat").all()) {
    await beat.scrollIntoViewIfNeeded();
    await expect(beat).toHaveCSS("opacity", "1");
    await expect(beat).toHaveCSS("transform", "none");
  }
  if (!isPhone(info)) {
    const boxes = await page
      .getByTestId("story-beat")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    const door = await page
      .locator(".l-door")
      .first()
      .evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
    for (const box of boxes) expect(door.top).toBeGreaterThanOrEqual(box.bottom);
    expect(Math.abs((boxes[0]?.left ?? Number.NaN) - door.left)).toBeLessThanOrEqual(1);
  }

  // The whole section as a test artifact.
  const path = info.outputPath("story.png");
  await story(page).screenshot({ path, animations: "disabled" });
  await info.attach("story", { path, contentType: "image/png" });
});

test("beats fade in on scroll; targets are 44 px; no CSP violation", async ({ page }) => {
  await open(page);
  await expect(story(page)).toHaveAttribute("data-reveal", "");
  const beats = page.getByTestId("story-beat");
  // Below the fold at load: hidden, waiting for the scroll.
  await expect(beats.nth(2)).not.toHaveAttribute("data-shown");
  await expect(beats.nth(2)).toHaveCSS("opacity", "0");
  await story(page).scrollIntoViewIfNeeded();
  for (const beat of await beats.all()) {
    await beat.scrollIntoViewIfNeeded();
    await expect(beat).toHaveAttribute("data-shown", "");
    await expect(beat).toHaveCSS("opacity", "1");
  }
  const small = await story(page)
    .locator("a")
    .evaluateAll((els) =>
      els
        .map((el) => ({ text: el.textContent, height: el.getBoundingClientRect().height }))
        .filter(({ height }) => height < 44),
    );
  expect(small).toEqual([]);

  const link = story(page).getByRole("link", { name: /^Time lock, Wikipedia/ });
  await link.focus();
  await expect(link).toHaveCSS("outline-style", "solid");

  // Keyboard: from the last source, Tab reaches the orange door with a ring that shows on it.
  await story(page)
    .getByRole("link", { name: /^Chain Signatures, NEAR documentation/ })
    .focus();
  await page.keyboard.press("Tab");
  const door = page
    .getByTestId("story-doors")
    .getByRole("link", { name: /^Try it with test coins/ });
  await expect(door).toBeFocused();
  const ring = await door.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      color: style.outlineColor,
      background: style.backgroundColor,
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.color).not.toBe(ring.background);
  expect(
    await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
  ).toEqual([]);
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("the beats show at once, with no fade", async ({ page }) => {
    await open(page);
    await expect(story(page)).not.toHaveAttribute("data-reveal");
    for (const beat of await page.getByTestId("story-beat").all()) {
      await expect(beat).toHaveCSS("opacity", "1");
      await expect(beat).toHaveCSS("transform", "none");
    }
  });
});
