import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { ROUND } from "./challenge-fixture.ts";
import {
  CHANGE,
  CODE_HASH,
  PROOF_ALLOWANCE_ADDRESS,
  PROOF_NEW_RECOVERY,
  PROOF_NOW,
  PROOF_RECOVERY,
  PROOF_VAULT,
  PROOF_VAULT_ADDRESS,
} from "./proof-fixture.ts";
import { CHALLENGE_URL, LIVE_WEB_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// Story 6.1: the Proof Page against the production build, a stub NEAR RPC (proof-fixture.ts)
// and a heartbeat the test controls. The page runs on a fake clock in UTC, so every absolute
// time it shows is fixed.

const ORANGE = "rgb(255, 122, 26)";
const ALARM = "rgb(255, 107, 91)";

const isPhone = (info: TestInfo) => info.project.name === "phone";
/** Every request to the stub NEAR RPC. */
const toRpc = (url: URL) => url.origin === new URL(RPC_URL).origin;

test.use({ timezoneId: "UTC" });

/** Serves `/heartbeat` as `minutes` old; `undefined` is an unreachable watcher. */
async function heartbeat(page: Page, minutes: number | undefined) {
  await page.route(`${WATCHER_URL}/heartbeat`, (route) => {
    if (minutes === undefined) return route.abort("connectionrefused");
    return route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
      contentType: "application/json",
      body: JSON.stringify({
        last_seq: "41",
        last_block_timestamp: null,
        updated_at: new Date(PROOF_NOW.getTime() - minutes * 60_000).toISOString(),
      }),
    });
  });
}

/** Opens `path` on the fake clock, recording every request and CSP violation. */
async function open(page: Page, path: string, minutes: number | undefined = 2) {
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  await page.clock.install({ time: PROOF_NOW });
  await heartbeat(page, minutes);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto(path);
  const fired = () =>
    page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);
  return { requests, fired };
}

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** Every check of Vault #7's proof, as the stub RPC serves it. */
async function expectVaultSeven(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Proof");
  await expect(page.getByText("vault #7", { exact: true })).toBeVisible();
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();

  const policy = region(page, "Policy");
  const rows: [string, string][] = [
    ["Delay", "24 h"],
    ["Policy Change Delay", "7 d"],
    ["Escape Timelock", "26,280 blocks"],
    ["Recovery Address", PROOF_RECOVERY],
    ["Allowance limit", "0.001 sBTC per 24 h"],
    ["Fee Cap", "0.0002 sBTC"],
    ["Fast Approval", "Off"],
  ];
  for (const [label, value] of rows) {
    const row = policy
      .locator("dl > div")
      .filter({ has: page.locator("dt").getByText(label, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row.locator("dd")).toHaveText(value);
  }
  await expect(page.getByTestId("proof-guardians").locator("li")).toHaveText([
    "alice.testnet (Trusted Contact)",
    "watcher.morrow.testnet (Auto-Clawback Guardian)",
  ]);

  // Op 2 was cancelled; op 3 is still pending. The change comes from get_vault.
  const pending = region(page, "Pending");
  await expect(pending.getByTestId("proof-withdrawal")).toHaveCount(1);
  await expect(pending.getByTestId("proof-withdrawal")).toContainText(
    "Withdrawal #3 · 0.0006 sBTC · executable 13 Nov 08:02",
  );
  await expect(pending.getByTestId("proof-change")).toHaveText(
    `Policy Change #${CHANGE.change_id} · Recovery Address → ${PROOF_NEW_RECOVERY} · effective 19 Nov 08:00`,
  );
  await expect(page.getByTestId("proof-truncated")).toHaveCount(0);

  const contract = region(page, "Contract");
  await expect(contract.getByTestId("proof-code-hash")).toHaveText(CODE_HASH);
  await expect(contract.getByTestId("proof-lock")).toHaveText("Locked: no full-access keys");
  await expect(contract.getByText("vault.morrow.testnet", { exact: true })).toBeVisible();
  await expect(contract.getByTestId("proof-explorer")).toHaveAttribute(
    "href",
    "https://testnet.nearblocks.io/address/vault.morrow.testnet",
  );

  await expect(region(page, "Vault").getByText(PROOF_VAULT.owner_account)).toBeVisible();
  const address = region(page, "Addresses");
  await expect(address.getByText(PROOF_VAULT_ADDRESS, { exact: true })).toBeVisible();
  await expect(address.getByText(PROOF_ALLOWANCE_ADDRESS, { exact: true })).toBeVisible();

  // Guarantees and trust statements from the Vault's values: a watcher, Fast Approval off.
  const ids = page.getByTestId("proof-statement");
  await expect(ids).toHaveCount(9);
  expect(await ids.evaluateAll((els) => els.map((el) => el.getAttribute("data-id")))).toEqual([
    "G-1",
    "G-2",
    "G-3",
    "G-4",
    "T-1",
    "T-2",
    "T-3",
    "T-4",
    "T-6",
  ]);
  const statement = (id: string) => page.locator(`[data-testid=proof-statement][data-id="${id}"]`);
  await expect(statement("G-1")).toContainText("A withdrawal waits 24 h.");
  await expect(statement("G-1")).toContainText(
    "No pending withdrawal can be signed before 13 Nov 08:02.",
  );
  await expect(statement("G-2")).toContainText(`Clawback pays only ${PROOF_RECOVERY}.`);
  await expect(statement("G-4")).toContainText(
    "Policy Change #4 cannot take effect before 19 Nov 08:00.",
  );
  await expect(statement("T-1")).toContainText("v1.signer-prod.testnet");
  await expect(statement("T-2")).toContainText(CODE_HASH);
  await expect(statement("T-3")).toContainText("This is the one theft path.");
  await expect(page.getByTestId("proof-residual")).toHaveCount(0);
}

test.describe("Proof Page", () => {
  test("/proof/7 renders the Vault live from chain, with no request beyond RPC and watcher", async ({
    page,
  }, info) => {
    const { requests, fired } = await open(page, "/proof/7");
    await expectVaultSeven(page);
    await expect(page).toHaveTitle("Proof · morrow");

    const heartbeatLine = page.getByTestId("proof-heartbeat");
    await expect(heartbeatLine).toHaveText("Alerts: watcher last seen 2 min ago");
    await expect(heartbeatLine).toHaveAttribute("data-alarm", "false");

    // Only the page's origin, the NEAR RPC and the watcher.
    const allowed = new Set([new URL(page.url()).origin, RPC_URL, WATCHER_URL]);
    const foreign = requests
      .map((r) => new URL(r.url()).origin)
      .filter((origin) => !allowed.has(origin));
    expect(foreign).toEqual([]);
    // The reads are the allowed ones only.
    const reads = requests
      .filter((r) => r.url().startsWith(RPC_URL) && r.method() === "POST")
      .map((r) => {
        const params = (r.postDataJSON() as { params: Record<string, string> }).params;
        return params.request_type === "call_function" ? params.method_name : params.request_type;
      });
    expect([...new Set(reads)].sort()).toEqual([
      "events_since",
      "get_vault",
      "view_access_key_list",
      "view_account",
    ]);
    expect(await fired()).toEqual([]);

    // No primary action yet: nothing orange.
    const orange = await page.evaluate(
      (color) =>
        Array.from(document.querySelectorAll<HTMLElement>("main *")).filter(
          (el) => getComputedStyle(el).backgroundColor === color,
        ).length,
      ORANGE,
    );
    expect(orange).toBe(0);

    // Two columns of cards on desktop, one under 900 px.
    const columns = await page
      .getByTestId("proof-columns")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(isPhone(info) ? 1 : 2);
  });

  test("a heartbeat older than 5 min turns the Alerts line to alarm; none reads unreachable", async ({
    page,
  }) => {
    await open(page, "/proof/7", 7);
    const line = page.getByTestId("proof-heartbeat");
    await expect(line).toHaveText("Alerts: watcher last seen 7 min ago");
    await expect(line).toHaveAttribute("data-alarm", "true");
    await expect(line).toHaveCSS("color", ALARM);

    await page.unroute(`${WATCHER_URL}/heartbeat`);
    await heartbeat(page, undefined);
    await page.clock.runFor(30_000);
    await expect(line).toHaveText("Alerts: watcher unreachable");
  });

  test("an unknown id reads No Vault on the contract, with the error code", async ({ page }) => {
    await open(page, "/proof/999");
    await expect(page.getByTestId("proof-missing")).toContainText(
      "No Vault #999 on vault.morrow.testnet",
    );
    await expect(page.getByTestId("proof-error-code")).toHaveText("ERR_VAULT_NOT_FOUND");
  });

  test("RPC down: says so with a retry, and keeps the last data after a first success", async ({
    page,
  }) => {
    await page.route(toRpc, (route) => route.abort("connectionrefused"));
    await open(page, "/proof/7");
    const down = page.getByTestId("proof-unreachable");
    await expect(down).toContainText("Could not reach NEAR");

    await page.unroute(toRpc);
    await down.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("proof-code-hash")).toHaveText(CODE_HASH);

    // Down again on the next 30 s refresh: the data stays, marked.
    await page.route(toRpc, (route) => route.abort("connectionrefused"));
    await page.clock.runFor(30_000);
    await expect(page.getByTestId("proof-stale")).toContainText("Could not reach NEAR");
    await expect(page.getByTestId("proof-code-hash")).toHaveText(CODE_HASH);
  });

  test("bare /proof without a round opens a Vault by id; non-digits are refused inline", async ({
    page,
  }) => {
    await open(page, "/proof");
    const form = region(page, "Open a Vault by id");
    await expect(form).toBeVisible();
    const input = form.getByLabel("Vault id");
    await input.fill("seven");
    await form.getByRole("button", { name: "Open" }).click();
    await expect(page.getByTestId("proof-open-error")).toHaveText(
      "A Vault id is digits only, for example 7.",
    );
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/proof$/);

    await input.fill("7");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/proof\/7$/);
    await expect(page.getByTestId("proof-code-hash")).toHaveText(CODE_HASH);
  });

  test("the landing's Proof link and Read the proof pill lead to /proof", async ({
    page,
  }, info) => {
    await page.goto("/");
    if (!isPhone(info)) {
      await expect(page.locator(".l-links").getByRole("link", { name: "Proof" })).toHaveAttribute(
        "href",
        "/proof",
      );
    }
    await expect(
      page.locator(".l-headline").getByRole("link", { name: "Read the proof" }),
    ).toHaveAttribute("href", "/proof");
  });
});

test.describe("Proof Page with the challenge feed", () => {
  test.use({ baseURL: LIVE_WEB_URL });

  test("bare /proof shows the live round's Vault", async ({ page }) => {
    // The open round's Vault is #7 here, so its full proof is served.
    await page.route(`${CHALLENGE_URL}/round`, (route) =>
      route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        contentType: "application/json",
        body: JSON.stringify({ ...ROUND, vault_id: "7" }),
      }),
    );
    const { fired } = await open(page, "/proof");
    await expect(page.getByText(`challenge round ${ROUND.round}`, { exact: true })).toBeVisible();
    await expectVaultSeven(page);
    expect(await fired()).toEqual([]);
  });
});
