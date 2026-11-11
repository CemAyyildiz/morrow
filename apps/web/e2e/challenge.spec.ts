import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import {
  CLAWBACK_TXID,
  EARLY_TX_HASH,
  OWNER_ACCOUNT,
  REQUEST_TX_HASH,
  ROUND,
  ROUND_NUMBER,
  VAULT_SATS,
  functionCallKey,
  type FunctionCallKey,
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

// Story 7.2b: "Try with these keys" signs real transactions in the browser. The stub RPC checks
// each signature and records what was sent. Every test serves the round with a key of its own,
// so parallel tests (and both projects) never share a nonce, an allowance or a record.

interface SentTx {
  public_key: string;
  hash: string;
  valid: boolean;
  nonce: number;
  method: string;
  args: Record<string, unknown>;
  op_id: string | null;
}

/** Serves `/round` with this test's own key; `set` swaps it for a fresh one (a new key). */
async function ownKey(page: Page, label: string, info: TestInfo) {
  let key = functionCallKey(`${label}-${info.project.name}-${info.retry}`);
  await page.route(`${CHALLENGE_URL}/round`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ...ROUND, near_function_call_key: key.secret }),
    }),
  );
  return {
    get: () => key,
    set: (next: FunctionCallKey) => {
      key = next;
    },
  };
}

async function sentWith(request: APIRequestContext, key: FunctionCallKey): Promise<SentTx[]> {
  const response = await request.get(
    `${RPC_URL}/__sent?public_key=${encodeURIComponent(key.publicKey)}`,
  );
  return (await response.json()) as SentTx[];
}

/** Every text the page logged, and both storages, for the secret-never-kept check. */
async function traces(page: Page, logged: string[]) {
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  return `${stored}\n${logged.join("\n")}`;
}

test.describe("Try with these keys", () => {
  test.use({ baseURL: LIVE_WEB_URL });

  test("the full-balance request: one signed send_tx, steps lit, then the Clawback from the feed", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "full", info);
    const logged: string[] = [];
    page.on("console", (message) => logged.push(message.text()));
    const { fired, violations } = await open(page, "/challenge");

    const panel = page.getByTestId("try-panel");
    await expect(panel.getByTestId("destination-random")).toHaveText("random");
    await expect(panel.getByTestId("try-destination")).toHaveValue(/^tb1q[02-9ac-hj-np-z]{38}$/);
    await expect(panel.getByTestId("xray-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByTestId("try-request")).toHaveAttribute("aria-disabled", "false");
    const destination = await panel.getByTestId("try-destination").inputValue();

    await page.getByRole("button", { name: "Try with these keys" }).click();
    const steps = panel.getByTestId("xray-step");
    await expect(steps.nth(1)).toContainText(
      /Accepted · executable at (\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d/,
    );
    await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "done");
    await expect(steps.nth(2)).toContainText(
      "not reached · the contract asks the MPC network only after the Delay",
    );
    await expect(steps.nth(3)).toContainText(/Waiting for the guardian · \d+ s/);

    // Exactly one transaction reached the RPC, with a valid signature from the published key.
    const sent = await sentWith(request, keys.get());
    expect(sent).toHaveLength(1);
    const tx = sent[0] as SentTx;
    expect(tx).toMatchObject({ valid: true, method: "request_withdrawal" });
    expect(tx.args).toMatchObject({
      vault_id: ROUND.vault_id,
      // The input total minus the fee bound 2 × (60 + 250 × 1) sats.
      amount_sats: String(VAULT_SATS - 620),
      destination,
      fee_rate_sat_vb: 2,
      utxos: [{ txid: ROUND.funding_txid, vout: 0, value_sats: String(VAULT_SATS) }],
    });
    expect(tx.args.envelope).toMatch(/^[0-9a-f]{160}$/);
    await expect(
      panel.getByRole("link", { name: "NEAR transaction of this attempt" }),
    ).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${tx.hash}`);
    const fullXray = panel.getByRole("link", { name: "Full X-Ray of this attempt, in a new tab" });
    await expect(fullXray).toHaveAttribute("href", `/xray/${tx.op_id}`);
    await expect(fullXray).toHaveAttribute("target", "_blank");

    // The watcher's Clawback reaches the feed: step 4 turns to it, with its Bitcoin link.
    const txid = "d2".repeat(32);
    await request.post(`${CHALLENGE_URL}/__attempt`, {
      data: { op_id: tx.op_id, clawback_txid: txid, clawback_broadcast: true },
    });
    await expect(steps.nth(3)).toContainText("Clawed back in 12 s", { timeout: 15_000 });
    await expect(steps.nth(3)).toHaveAttribute("data-state", "ok");
    await expect(
      panel.getByRole("link", { name: "Bitcoin Clawback transaction of this attempt" }),
    ).toHaveAttribute("href", `https://mempool.space/signet/tx/${txid}`);
    await expect(page.getByTestId("live-region")).toContainText(/Clawed back in 12 s|Attempt \d+/);

    // The session key is never stored or logged.
    const secret = keys.get().secret;
    const kept = await traces(page, logged);
    expect(kept).not.toContain(secret);
    expect(kept).not.toContain(secret.slice("ed25519:".length, 30));
    expect(await sentWith(request, keys.get())).toHaveLength(1);
    expect(await fired()).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("Execute early on the pending request is refused with ERR_NOT_EXECUTABLE", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "early", info);
    const { fired } = await open(page, "/challenge");
    const panel = page.getByTestId("try-panel");
    const execute = panel.getByTestId("try-execute");
    await expect(execute).toHaveAttribute("aria-disabled", "false");
    await expect(panel.getByTestId("try-execute-reason")).toHaveText("Executes request op 12");
    await execute.click();
    const steps = panel.getByTestId("xray-step");
    await expect(steps.nth(1)).toContainText("Refused · ERR_NOT_EXECUTABLE");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "refused");
    await expect(steps.nth(2)).toHaveAttribute("data-state", "unreached");
    await expect(steps.nth(3)).toHaveAttribute("data-state", "unreached");
    const sent = await sentWith(request, keys.get());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ valid: true, method: "begin_execute", args: { op_id: "12" } });
    // The refused call's full X-Ray names its signer, so the page need not wait for the indexer.
    await expect(
      panel.getByRole("link", { name: "Full X-Ray of this attempt, in a new tab" }),
    ).toHaveAttribute("href", `/xray/tx/${sent[0]?.hash}?sender=${OWNER_ACCOUNT}`);
    expect(await fired()).toEqual([]);
  });

  test("Execute early is disabled with a reason while no request is pending", async ({
    page,
  }, info) => {
    await ownKey(page, "none-pending", info);
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
    await open(page, "/challenge");
    const panel = page.getByTestId("try-panel");
    await expect(panel.getByTestId("try-execute")).toHaveAttribute("aria-disabled", "true");
    await expect(panel.getByTestId("try-execute-reason")).toHaveText(
      "No withdrawal request is pending. Request the full balance first.",
    );
    // The X-Ray is on by default and can be turned off and on from the keyboard.
    const toggle = panel.getByTestId("xray-toggle");
    await expect(panel.getByTestId("xray")).toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(panel.getByTestId("xray")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(panel.getByTestId("xray")).toBeVisible();
    // Every control of the panel is at least 44 px tall.
    for (const control of await panel.locator("button, input").all()) {
      expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("a bad destination shows an inline error and signs nothing", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "bad-destination", info);
    const rpcCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith(RPC_URL)) rpcCalls.push(r.postData() ?? "");
    });
    await open(page, "/challenge");
    const panel = page.getByTestId("try-panel");
    await expect(panel.getByTestId("try-request")).toHaveAttribute("aria-disabled", "false");
    const input = panel.getByTestId("try-destination");
    for (const [address, error] of [
      ["tb1qnotanaddress", "This is not a valid SegWit address. Nothing was signed."],
      [
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        "This address belongs to another Bitcoin network. Nothing was signed.",
      ],
    ]) {
      await input.fill(address as string);
      await expect(panel.getByTestId("destination-random")).toHaveCount(0);
      await panel.getByTestId("try-request").click();
      await expect(panel.getByTestId("try-destination-error")).toHaveText(error as string);
      await expect(input).toHaveAttribute("aria-invalid", "true");
    }
    expect(rpcCalls.filter((body) => /view_access_key"|send_tx/.test(body))).toEqual([]);
    expect(await sentWith(request, keys.get())).toEqual([]);
  });

  test("a spent key: a fresh key is being published, and the button returns with it", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "spent", info);
    await request.post(`${RPC_URL}/__allowance`, {
      data: { public_key: keys.get().publicKey, spent: true },
    });
    await open(page, "/challenge");
    const panel = page.getByTestId("try-panel");
    const button = panel.getByTestId("try-request");
    await expect(button).toHaveAttribute("aria-disabled", "false");
    await button.click();
    await expect(panel.getByTestId("try-request-reason")).toContainText(
      "A fresh key is being published",
    );
    await expect(panel.getByTestId("try-notice")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-disabled", "true");

    // The operator publishes a fresh key: `/round` is asked with every Attempt Log poll.
    keys.set(functionCallKey(`spent-fresh-${info.project.name}-${info.retry}`));
    await expect(button).toHaveAttribute("aria-disabled", "false", { timeout: 15_000 });
    await expect(panel.getByTestId("try-request-reason")).toHaveCount(0);
  });

  test("a nonce race is retried once with a fresh nonce", async ({ page, request }, info) => {
    const keys = await ownKey(page, "nonce", info);
    await request.post(`${RPC_URL}/__nonce`, {
      data: { public_key: keys.get().publicKey, race: 1 },
    });
    await open(page, "/challenge");
    const panel = page.getByTestId("try-panel");
    await expect(panel.getByTestId("try-request")).toHaveAttribute("aria-disabled", "false");
    await panel.getByTestId("try-request").click();
    await expect(panel.getByTestId("xray-step").nth(1)).toContainText("Accepted");
    const sent = await sentWith(request, keys.get());
    expect(sent).toHaveLength(2);
    // `final` still answered the old nonce: the retry signs above the ak_nonce the error named.
    expect((sent[1] as SentTx).nonce - (sent[0] as SentTx).nonce).toBe(5);
  });

  test("the landing's Try sends the real full-balance request in place", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "landing", info);
    const { fired, violations } = await open(page, "/");
    await page.getByTestId("landing-stage").evaluate((stage: HTMLElement) => {
      const top = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + stage.offsetHeight - window.innerHeight);
    });
    const product = page.getByTestId(isPhone(info) ? "landing-mobview" : "landing-crisp");
    await expect(product).toHaveCSS("opacity", "1");
    // The coins (balance) and get_vault (Delay, watcher key) have answered: press Try.
    await expect(product.getByTestId("stat-value").first()).toHaveText("0.01000000");
    await expect(product.getByTestId("stat-value").nth(1)).toHaveText("24 h");
    await product.getByRole("button", { name: "Try with these keys" }).click();
    await expect(product.getByTestId("xray-step").nth(1)).toContainText(
      /Accepted · executable at/,
      { timeout: 15_000 },
    );
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("live-region")).toContainText("Contract rule: Accepted");
    const sent = await sentWith(request, keys.get());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ valid: true, method: "request_withdrawal" });
    expect(String((sent[0] as SentTx).args.destination)).toMatch(/^tb1q[02-9ac-hj-np-z]{38}$/);
    expect(await fired()).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("the landing's Try opens /challenge when the request cannot be sent", async ({
    page,
    request,
  }, info) => {
    const keys = await ownKey(page, "landing-fallback", info);
    // get_vault without a watcher key: no envelope can be sealed, so nothing can be sent.
    await page.route(RPC_URL, async (route) => {
      const call = route.request().postDataJSON() as {
        id?: unknown;
        params?: Record<string, unknown>;
      };
      if (call.params?.method_name !== "get_vault") return route.fallback();
      const vault = {
        vault_id: ROUND.vault_id,
        owner_account: OWNER_ACCOUNT,
        state: "active",
        policy: { delay_ns: "86400000000000", escape_timelock_blocks: 1000, btc_network: "signet" },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: {
            block_hash: "stub",
            block_height: 1,
            logs: [],
            result: [...new TextEncoder().encode(JSON.stringify(vault))],
          },
        }),
      });
    });
    await open(page, "/");
    await page.getByTestId("landing-stage").evaluate((stage: HTMLElement) => {
      const top = stage.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + stage.offsetHeight - window.innerHeight);
    });
    const product = page.getByTestId(isPhone(info) ? "landing-mobview" : "landing-crisp");
    await expect(product).toHaveCSS("opacity", "1");
    await expect(product.getByTestId("stat-value").nth(1)).toHaveText("24 h");
    await product.getByRole("button", { name: "Try with these keys" }).click();
    await expect(page).toHaveURL(/\/challenge$/);
    await expect(page.getByTestId("try-request-reason")).toHaveText(
      "The vault's watcher key cannot be read, so no envelope can be sealed.",
    );
    expect(await sentWith(request, keys.get())).toEqual([]);
  });
});
