import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import {
  CLAWBACK_TXID,
  EARLY_TX_HASH,
  OWNER_ACCOUNT,
  REQUEST_TX_HASH,
  ROUND,
  ROUND_NUMBER,
} from "./challenge-fixture.ts";
import {
  BACKEND_URL,
  BOUNTY_URL,
  CHALLENGE_URL,
  LIVE_WEB_URL,
  RPC_URL,
  WATCHER_URL,
} from "./services.ts";

// Story 7.2a: the Challenge page with the live feed, against the production build served with
// MORROW_CHALLENGE_URL (a stub of `tools/challenge run`), a stub Bitcoin backend and a stub
// NEAR RPC. Restores the 1.9b rendering checks that need round data.

const ORANGE = "rgb(255, 122, 26)";
const OK = "rgb(126, 226, 168)";
const LIVE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; " +
  `connect-src 'self' ${RPC_URL} ${BACKEND_URL} ${WATCHER_URL} ${CHALLENGE_URL}; ` +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const isPhone = (info: TestInfo) => info.project.name === "phone";

/** Opens `path`, records every request and collects CSP violations. */
async function open(page: Page, path: string) {
  const requests: Request[] = [];
  const violations: string[] = [];
  page.on("request", (request) => requests.push(request));
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  const response = await page.goto(path);
  await page.waitForLoadState("networkidle");
  const fired = () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
  return { response, requests, violations, fired };
}

test.describe("with the challenge feed", () => {
  test.use({ baseURL: LIVE_WEB_URL });

  test("/challenge shows the round, its facts and the live numbers, with no CSP violation", async ({
    page,
  }) => {
    const { response, violations, fired } = await open(page, "/challenge");
    expect(response?.headers()["content-security-policy"]).toBe(LIVE_CSP);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
    await expect(page.getByText(`round ${ROUND_NUMBER}`, { exact: true })).toBeVisible();
    await expect(page.getByText("keys published", { exact: true })).toBeVisible();
    await expect(page.getByTestId("coins-note")).toHaveText("Signet test coins · not real bitcoin");
    await expect(page.getByTestId("rotation")).toHaveText(
      /^New vault by block 291,744 · about (\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d$/,
    );
    await expect(page.getByTestId("bounty-link")).toHaveAttribute("href", BOUNTY_URL);

    // Hero: the pending request's executable_at, 6 of its 24 h gone.
    const hero = page.getByTestId("hero");
    await expect(page.getByTestId("hero-time")).toHaveText(/^\d\d:\d\d$/);
    await expect(hero.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    await expect(hero).toContainText(/Requested (\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d/);
    // About 18 h left (the stub's clock started a little earlier).
    await expect(hero).toContainText(/1[78] h( \d+ m)? left/);
    await expect(page.getByTestId("attempts-count")).toHaveText(/^\d+$/);
    await expect(hero).toContainText(`Round ${ROUND_NUMBER} · last 24 h`);

    // Stats: balance, Delay, sats taken in the ok tone, MPC threshold.
    const values = page.getByTestId("stat-value");
    await expect(values).toHaveText(["0.01000000", "24 h", "0", "11/16"]);
    await expect(page.getByTestId("stats")).toContainText("sBTC");
    await expect(values.nth(2).locator("..")).toHaveCSS("color", OK);

    expect(await fired()).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("one orange primary, and Tab goes Download keys → Try with these keys", async ({ page }) => {
    await open(page, "/challenge");
    await expect(page.getByTestId("hero-time")).toBeVisible();
    const orange = await page.evaluate(
      (color) =>
        Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
          const rect = el.getBoundingClientRect();
          return (
            rect.width > 0 && rect.height > 0 && getComputedStyle(el).backgroundColor === color
          );
        }).length,
      ORANGE,
    );
    expect(orange).toBe(1);
    const download = page.getByRole("button", { name: "Download keys" });
    await download.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Try with these keys" })).toBeFocused();
  });

  test("the Attempt Log shows the rows with their explorer links", async ({ page }, info) => {
    test.skip(isPhone(info), "the log hides on phones (EXPERIENCE.md)");
    await open(page, "/challenge");
    const rows = page.getByTestId("attempt-row");
    const clawed = rows.filter({ hasText: "#1" });
    await expect(clawed).toContainText("Withdrawal Request");
    await expect(clawed).toContainText("Clawed back in 41 s");
    await expect(
      clawed.getByRole("link", { name: "NEAR transaction of attempt 1" }),
    ).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${REQUEST_TX_HASH}`);
    await expect(
      clawed.getByRole("link", { name: "Bitcoin transaction of attempt 1" }),
    ).toHaveAttribute("href", `https://mempool.space/signet/tx/${CLAWBACK_TXID}`);

    const early = rows.filter({ hasText: "#2" });
    await expect(early).toContainText("Early Execute");
    await expect(early).toContainText("Rejected ERR_NOT_EXECUTABLE");
    await expect(
      early.getByRole("link", { name: "NEAR transaction of attempt 2" }),
    ).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${EARLY_TX_HASH}`);
    await expect(early.getByRole("link", { name: /Bitcoin/ })).toHaveCount(0);

    // Its hash is not known yet: the Owner Account page stands in.
    const pending = rows.filter({ hasText: "#3" });
    await expect(pending).toContainText("Pending");
    await expect(
      pending.getByRole("link", { name: "Owner Account of attempt 3 on NEAR" }),
    ).toHaveAttribute("href", `https://testnet.nearblocks.io/address/${OWNER_ACCOUNT}`);

    // Key rotations are not attempts.
    await expect(rows.filter({ hasText: /key/i })).toHaveCount(0);
  });

  test("a new attempt appears within one poll, flashes and is announced", async ({
    page,
    request,
  }, info) => {
    await open(page, "/challenge");
    // The first /attempts answer is in (the count shows): its rows are not new.
    await expect(page.getByTestId("attempts-count")).toBeVisible();
    const region = page.getByTestId("live-region");
    await expect(region).not.toContainText("Attempt");
    if (!isPhone(info)) {
      await expect(page.getByTestId("attempt-row").first()).toBeVisible();
      await expect(page.locator("[data-testid=attempt-row].animate-row-flash")).toHaveCount(0);
    }
    const added = (await (await request.post(`${CHALLENGE_URL}/__attempt`)).json()) as {
      n: number;
    };
    await expect(region).toContainText(
      `Attempt ${added.n}: Withdrawal Request, Clawed back in 12 s`,
      { timeout: 15_000 },
    );
    if (!isPhone(info)) {
      const row = page.getByTestId("attempt-row").filter({ hasText: `#${added.n}` });
      await expect(row).toHaveClass(/animate-row-flash/);
    }
  });

  test('"Download keys" saves the public round as JSON', async ({ page }) => {
    await open(page, "/challenge");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download keys" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`morrow-challenge-round-${ROUND_NUMBER}.json`);
    const path = await download.path();
    const body = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { how_to: howTo, ...round } = body;
    expect(round).toEqual(ROUND);
    expect(howTo).toEqual(expect.stringContaining("owner_key_secret"));
    expect(JSON.stringify(body)).not.toMatch(/full_access|operator_key|recovery_key/);
  });

  test("the page follows /round: a new round, a failed poll that keeps it, then a 404", async ({
    page,
  }) => {
    await page.clock.install();
    let answer: { status: number; body: unknown } = { status: 200, body: ROUND };
    await page.route(`${CHALLENGE_URL}/round`, (route) =>
      route.fulfill({
        status: answer.status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(answer.body),
      }),
    );
    await open(page, "/challenge");
    await expect(page.getByText(`round ${ROUND_NUMBER}`, { exact: true })).toBeVisible();

    /** Moves past the next 30 s `/round` poll and waits for its answer. */
    const nextPoll = async (status: number) => {
      const response = page.waitForResponse(
        (r) => r.url() === `${CHALLENGE_URL}/round` && r.status() === status,
      );
      await page.clock.fastForward("00:31");
      await response;
    };

    answer = { status: 200, body: { ...ROUND, round: 4, vault_id: "43" } };
    await nextPoll(200);
    await expect(page.getByText("round 4", { exact: true })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download keys" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("morrow-challenge-round-4.json");

    // Unreachable after data: the round shown stays.
    answer = { status: 503, body: { error: "unavailable" } };
    await nextPoll(503);
    await expect(page.getByText("round 4", { exact: true })).toBeVisible();
    await expect(page.getByTestId("challenge-unreachable")).toHaveCount(0);

    answer = { status: 404, body: { error: "no open round" } };
    await nextPoll(404);
    await expect(page.getByTestId("challenge-empty")).toContainText("No round is open yet");
  });

  test("before /round answers nothing is claimed; a 503 from the start reads as unreachable", async ({
    page,
  }) => {
    let release: (status: number) => void = () => undefined;
    const held = new Promise<number>((resolve) => (release = resolve));
    await page.route(`${CHALLENGE_URL}/round`, async (route) => {
      const status = await held;
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: "unavailable" }),
      });
    });
    await page.goto("/challenge");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
    await expect(page.getByTestId("challenge-empty")).toHaveCount(0);
    await expect(page.getByTestId("challenge-unreachable")).toHaveCount(0);
    await expect(page.getByTestId("hero")).toHaveCount(0);

    release(503);
    await expect(page.getByTestId("challenge-unreachable")).toContainText(
      "The Challenge feed is not answering",
    );
    await expect(page.getByTestId("challenge-empty")).toHaveCount(0);
  });

  test("no pending request, no attempt yet and an unreadable co-signer", async ({ page }) => {
    await page.route(`${CHALLENGE_URL}/attempts`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          entries: [],
          summary: {
            round: ROUND_NUMBER,
            attempts_round: 0,
            attempts_total: 0,
            sats_taken_total: 0,
            last_attempt_at: null,
          },
        }),
      }),
    );
    await page.route(RPC_URL, async (route) => {
      const call = route.request().postDataJSON() as {
        id?: unknown;
        params?: Record<string, unknown>;
      };
      if (call.params?.method_name !== "state") return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { name: "HANDLER_ERROR" } }),
      });
    });
    await open(page, "/challenge");
    const hero = page.getByTestId("hero");
    await expect(hero).toContainText("No withdrawal request is pending");
    await expect(hero).toContainText("24 h delay");
    await expect(page.getByTestId("hero").getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
    await expect(hero).toContainText("No attempt yet");
    await expect(page.getByTestId("stat-value")).toHaveText(["0.01000000", "24 h", "0"]);
    await expect(page.getByTestId("stats").locator("[data-slot=skeleton]")).toHaveCount(0);
  });

  test('"Download keys" in the landing\'s product saves the live round', async ({ page }, info) => {
    await open(page, "/");
    await page.getByTestId("landing-stage").evaluate((stage: HTMLElement) => {
      const top = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + stage.offsetHeight - window.innerHeight);
    });
    const product = page.getByTestId(isPhone(info) ? "landing-mobview" : "landing-crisp");
    await expect(product).toHaveCSS("opacity", "1");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      product.getByRole("button", { name: "Download keys" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`morrow-challenge-round-${ROUND_NUMBER}.json`);
    await expect(page).toHaveURL(/\/$/);
  });

  test("/rob redirects to /challenge", async ({ page }) => {
    const { violations, fired } = await open(page, "/rob");
    await expect(page).toHaveURL(/\/challenge$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Challenge vault");
    expect(await fired()).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("the landing shows the live round and the real counts", async ({ page }, info) => {
    const { violations, fired } = await open(page, "/");
    await expect(page.getByTestId("record")).toContainText(
      /\d+ attempts? with the real keys\.\s*0 sats left the vault\./,
    );
    await expect(page.getByTestId("record")).toContainText(`round ${ROUND_NUMBER}`);
    const product = page.getByTestId(isPhone(info) ? "landing-mobview" : "landing-crisp");
    await expect(product.getByText(`round ${ROUND_NUMBER}`, { exact: true })).toBeAttached();
    expect(await fired()).toEqual([]);
    expect(violations).toEqual([]);
  });
});

test.describe("with the challenge feed failing or closed", () => {
  test.use({ baseURL: LIVE_WEB_URL });

  test("feed down: /attempts fails after data, the last rows stay and none is made up", async ({
    page,
  }) => {
    let answered = 0;
    await page.route(`${CHALLENGE_URL}/attempts`, (route) => {
      answered++;
      return answered === 1
        ? route.fallback()
        : route.fulfill({ status: 503, body: '{"error":"unavailable"}' });
    });
    await open(page, "/challenge");
    await expect(page.getByTestId("hero-time")).toBeVisible();
    const count = await page.getByTestId("attempts-count").textContent();
    const rows = await page.getByTestId("attempt-row").allTextContents();

    // The next poll fails; the page keeps the last answer.
    await page.waitForResponse(
      (r) => r.url() === `${CHALLENGE_URL}/attempts` && r.status() === 503,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("attempts-count")).toHaveText(count ?? "");
    expect(await page.getByTestId("attempt-row").allTextContents()).toEqual(rows);
    await expect(page.getByTestId("challenge-empty")).toHaveCount(0);
  });

  test("no feed: /round answers 404, so no round is shown and the landing keeps its fallback", async ({
    page,
  }) => {
    await page.route(`${CHALLENGE_URL}/round`, (route) =>
      route.fulfill({ status: 404, body: '{"error":"not found"}' }),
    );
    for (const path of ["/challenge", "/"]) {
      const { requests } = await open(page, path);
      // Without a round the feed's other parts are never asked.
      expect(requests.filter((r) => r.url() === `${CHALLENGE_URL}/attempts`)).toEqual([]);
      if (path === "/challenge") {
        await expect(page.getByTestId("challenge-empty")).toContainText("No round is open yet");
        await expect(page.getByTestId("stat-value")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("record")).toContainText("The real keys are published.");
        await expect(page.getByTestId("record")).not.toContainText(/\d/);
      }
    }
  });

  test("bounty unset: the round facts render no bounty slot", async ({ page }) => {
    await page.route("**/config.json", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, bounty_url: null } });
    });
    await open(page, "/challenge");
    await expect(page.getByTestId("coins-note")).toBeVisible();
    await expect(page.getByTestId("bounty-link")).toHaveCount(0);
    await expect(page.getByTestId("round-facts").getByRole("link")).toHaveCount(0);
  });
});

test.describe("without a challenge feed", () => {
  test("no request goes to a challenge origin and no number is invented", async ({ page }) => {
    for (const path of ["/challenge", "/"]) {
      const { requests } = await open(page, path);
      expect(requests.filter((r) => r.url().startsWith(CHALLENGE_URL))).toEqual([]);
      if (path === "/challenge") {
        await expect(page.getByTestId("challenge-empty")).toContainText("No round is open yet");
        await expect(page.getByTestId("stat-value")).toHaveCount(0);
      } else {
        // The record line keeps its no-number fallback.
        await expect(page.getByTestId("record")).toContainText("The real keys are published.");
        await expect(page.getByTestId("record")).not.toContainText(/\d/);
      }
    }
  });
});
