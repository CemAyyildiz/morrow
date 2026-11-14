import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { ROUND } from "./challenge-fixture.ts";
import {
  CHANGE,
  CODE_HASH,
  PROOF_ALLOWANCE_ADDRESS,
  PROOF_NEW_RECOVERY,
  PROOF_NOW,
  PROOF_RECOVERY,
  PROOF_EVENTS,
  PROOF_KIT,
  PROOF_VAULT,
  PROOF_VAULT_ADDRESS,
  PROOF_VAULT_SCRIPT,
  vaultScriptHex,
} from "./proof-fixture.ts";
import { CHALLENGE_URL, LIVE_WEB_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// Story 6.1: the Proof Page against the production build, a stub NEAR RPC (proof-fixture.ts)
// and a heartbeat the test controls. The page runs on a fake clock in UTC, so every absolute
// time it shows is fixed.

const ORANGE = "rgb(255, 122, 26)";
const ALARM = "rgb(255, 107, 91)";
const OK = "rgb(126, 226, 168)";

const isPhone = (info: TestInfo) => info.project.name === "phone";
/** Every request to the stub NEAR RPC. */
const toRpc = (url: URL) => url.origin === new URL(RPC_URL).origin;

test.use({ timezoneId: "UTC" });

const CORS = { "access-control-allow-origin": "*", "cache-control": "no-store" };
const nsOf = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/** A `call_function` result carrying `value`. */
const viewOk = (value: unknown) => ({
  result: {
    block_hash: "stub",
    block_height: 1,
    logs: [],
    result: [...Buffer.from(JSON.stringify(value))],
  },
});

/** `events_since` over `events`: `seq > cursor`, at most `limit`. */
const eventsOver = (events: readonly { seq: string }[], args: Record<string, unknown>) =>
  viewOk(
    events.filter((e) => BigInt(e.seq) > BigInt(String(args.cursor))).slice(0, Number(args.limit)),
  );

/**
 * Answers the NEAR RPC calls `answer` returns a body for (`{ result }` or `{ error }`); every
 * other call goes on to the stub.
 */
async function routeRpc(
  page: Page,
  answer: (
    params: Record<string, unknown>,
    args: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
) {
  await page.route(toRpc, (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const call = request.postDataJSON() as { id?: unknown; params?: Record<string, unknown> };
    const params = call.params ?? {};
    const args =
      params.request_type === "call_function"
        ? (JSON.parse(Buffer.from(String(params.args_base64), "base64").toString()) as Record<
            string,
            unknown
          >)
        : {};
    const body = answer(params, args);
    if (body === undefined) return route.fallback();
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? null, ...body }),
    });
  });
}

/** Serves Vault #7's `get_vault` as `vault`, and `events_since` over `events` when given. */
function vaultSeven(vault: Record<string, unknown>, events?: readonly { seq: string }[]) {
  return (params: Record<string, unknown>, args: Record<string, unknown>) => {
    if (params.method_name === "get_vault" && args.vault_id === "7") return viewOk(vault);
    if (params.method_name === "events_since" && events) return eventsOver(events, args);
    return undefined;
  };
}

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

/** The text of every element in main with an orange background. */
const orangeElements = (page: Page) =>
  page.evaluate(
    (color) =>
      Array.from(document.querySelectorAll<HTMLElement>("main *"))
        .filter((el) => getComputedStyle(el).backgroundColor === color)
        .map((el) => el.textContent?.trim() ?? ""),
    ORANGE,
  );

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
  await expect(page.getByTestId("proof-guardian")).toHaveText([
    "alice.testnet (Trusted Contact)",
    "watcher.morrow.testnet (Auto-Clawback Guardian)",
  ]);

  // Op 2 was cancelled; op 3 is still pending. The change comes from get_vault.
  const pending = region(page, "Pending");
  await expect(pending.getByTestId("proof-withdrawal")).toHaveCount(1);
  await expect(pending.getByTestId("proof-withdrawal")).toContainText(
    "Withdrawal #3 · 0.0006 sBTC · executable 13 Nov 08:02",
  );
  await expect(pending.getByRole("link", { name: "X-Ray of op 3" })).toHaveAttribute(
    "href",
    "/xray/3",
  );
  await expect(pending.getByTestId("proof-change")).toHaveText(
    `Policy Change #${CHANGE.change_id} · Recovery Address → ${PROOF_NEW_RECOVERY} · effective 19 Nov 08:00`,
  );
  await expect(page.getByTestId("proof-reading")).toHaveCount(0);
  await expect(page.getByTestId("proof-guardians")).toContainText(
    `key ${PROOF_VAULT.policy.guardians[0]?.guardian_key}`,
  );

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
  await expect(statement("T-2").getByRole("link")).toHaveAttribute(
    "href",
    "https://github.com/CemAyyildiz/morrow",
  );
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
    await expect(heartbeatLine).toHaveText("Deployment watcher last seen 2 min ago");
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

    // One primary action: the Address card's Recompute, the only orange on the page.
    expect(await orangeElements(page)).toEqual(["Recompute"]);

    // Two columns of cards on desktop, one under 900 px.
    const columns = await page
      .getByTestId("proof-columns")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(isPhone(info) ? 1 : 2);
  });

  test("a heartbeat older than 5 min turns the watcher line to alarm; none reads unreachable", async ({
    page,
  }) => {
    await open(page, "/proof/7", 7);
    const line = page.getByTestId("proof-heartbeat");
    await expect(line).toHaveText("Deployment watcher last seen 7 min ago");
    await expect(line).toHaveAttribute("data-alarm", "true");
    await expect(line).toHaveCSS("color", ALARM);

    await page.unroute(`${WATCHER_URL}/heartbeat`);
    await heartbeat(page, undefined);
    await page.clock.runFor(30_000);
    await expect(line).toHaveText("Deployment watcher unreachable");
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

test.describe("Proof Page states", () => {
  const statement = (page: Page, id: string) =>
    page.locator(`[data-testid=proof-statement][data-id="${id}"]`);

  test("a clawed-back Vault: the banner with its absolute time and the closed-Vault statement", async ({
    page,
  }) => {
    const events = [
      ...PROOF_EVENTS,
      {
        seq: String(PROOF_EVENTS.length + 1),
        block_timestamp: nsOf("2026-11-12T08:30:00Z"),
        vault_id: "7",
        kind: "vault_clawed_back",
        data: { op_id: "9", by: "watcher.morrow.testnet", recovery_address: PROOF_RECOVERY },
      },
    ];
    await routeRpc(
      page,
      vaultSeven({ ...PROOF_VAULT, state: "clawed_back", pending_change: null }, events),
    );
    await open(page, "/proof/7");
    await expect(page.getByTestId("proof-clawed-back")).toContainText(
      `Sent home to ${PROOF_RECOVERY} · 08:30`,
    );
    await expect(page.getByText("clawed back", { exact: true }).first()).toBeVisible();
    await expect(statement(page, "Closed")).toContainText(
      `This Vault was sent home to ${PROOF_RECOVERY} at 08:30; no other spend can be co-signed.`,
    );
    await expect(statement(page, "G-1")).toHaveCount(0);
  });

  test("a Vault whose keys are still being derived: the not-active notice, no guarantees", async ({
    page,
  }) => {
    await routeRpc(
      page,
      vaultSeven({
        ...PROOF_VAULT,
        state: "pending_keys",
        addresses: null,
        cosigner_pubkeys: null,
        pending_change: null,
      }),
    );
    await open(page, "/proof/7");
    await expect(page.getByTestId("proof-not-active")).toContainText(
      "This Vault is not active yet",
    );
    await expect(statement(page, "G-1")).toHaveCount(0);
    await expect(region(page, "Addresses")).toContainText("Not active yet");
  });

  test("Fast Approval on: T-5 with the Floor", async ({ page }) => {
    await routeRpc(
      page,
      vaultSeven({ ...PROOF_VAULT, policy: { ...PROOF_VAULT.policy, fast_approval: true } }),
    );
    await open(page, "/proof/7");
    await expect(statement(page, "T-5")).toContainText(
      "the theft completes after the Fast Approval Floor of 1 h instead of 24 h",
    );
    await expect(
      region(page, "Policy").locator("dd").getByText("On · Floor 1 h", { exact: true }),
    ).toBeVisible();
  });

  test("an unlocked contract is alarm; an unreadable key list says so", async ({ page }) => {
    let keys: unknown[] = [
      { public_key: "ed25519:1", access_key: { nonce: 1, permission: "FullAccess" } },
    ];
    await routeRpc(page, (params) =>
      params.request_type === "view_access_key_list"
        ? { result: { block_hash: "stub", block_height: 1, keys } }
        : undefined,
    );
    await open(page, "/proof/7");
    const lock = page.getByTestId("proof-lock");
    await expect(lock).toHaveText("Unlocked: 1 full-access key");
    await expect(lock).toHaveCSS("color", ALARM);

    keys = [{ public_key: "ed25519:1", access_key: { nonce: 1, permission: "Odd" } }];
    // A 30 s tick that lands while the first read is still out is skipped: tick until one reads.
    await expect(async () => {
      await page.clock.runFor(30_000);
      await expect(lock).toHaveText("Lock status could not be read", { timeout: 1_000 });
    }).toPass();
    await expect(lock).toHaveCSS("color", ALARM);
  });

  test("a long history: reads on each refresh, says so, and claims nothing pending until caught up", async ({
    page,
  }) => {
    const created = {
      seq: "1",
      block_timestamp: PROOF_VAULT.created_at,
      vault_id: "7",
      kind: "vault_created",
      data: { owner_account: PROOF_VAULT.owner_account },
    };
    const fillers = Array.from({ length: 5_050 }, (_, i) => ({
      seq: String(i + 2),
      block_timestamp: (BigInt(PROOF_VAULT.created_at) + BigInt(i + 1)).toString(),
      vault_id: "42",
      kind: "storage_topped_up",
      data: { amount_yocto: "1" },
    }));
    const request = {
      seq: String(fillers.length + 2),
      block_timestamp: nsOf("2026-11-12T08:02:00Z"),
      vault_id: "7",
      kind: "withdrawal_requested",
      data: {
        op_id: "3",
        amount_sats: "60000",
        destination: "tb1qprooftheif",
        executable_at: nsOf("2026-11-13T08:02:00Z"),
      },
    };
    await routeRpc(
      page,
      vaultSeven({ ...PROOF_VAULT, pending_change: null }, [created, ...fillers, request]),
    );
    await open(page, "/proof/7");
    const pending = region(page, "Pending");
    await expect(pending.getByTestId("proof-reading")).toHaveText(
      "Reading the history · 5,000 events read",
    );
    await expect(pending).not.toContainText("No Withdrawal Request");
    await expect(statement(page, "G-1")).not.toContainText("can be signed before");

    await page.clock.runFor(30_000);
    await expect(pending.getByTestId("proof-reading")).toHaveCount(0);
    await expect(pending.getByTestId("proof-withdrawal")).toContainText(
      "Withdrawal #3 · 0.0006 sBTC · executable 13 Nov 08:02",
    );
    await expect(statement(page, "G-1")).toContainText(
      "No pending withdrawal can be signed before 13 Nov 08:02.",
    );
  });

  test("a contract that is not a Vault Contract gets its own notice", async ({ page }) => {
    await routeRpc(page, (params) =>
      params.method_name === "get_vault"
        ? { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} } } }
        : undefined,
    );
    await open(page, "/proof/7");
    await expect(page.getByTestId("proof-misconfigured")).toContainText(
      "The contract vault.morrow.testnet did not answer as a Vault Contract",
    );
    await expect(page.getByTestId("proof-missing")).toHaveCount(0);
  });

  test("a padded id is rewritten to the canonical address", async ({ page }) => {
    await open(page, "/proof/007");
    await expect(page).toHaveURL(/\/proof\/7$/);
    await expect(page.getByText("vault #7", { exact: true })).toBeVisible();
  });

  test("the Proof nav item is the current page on /proof and /proof/7", async ({ page }, info) => {
    test.skip(isPhone(info), "the sidebar is desktop only");
    for (const path of ["/proof", "/proof/7"]) {
      await open(page, path);
      await expect(page.getByTestId("sidebar").locator("[aria-current=page]")).toHaveText("Proof");
    }
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

  test("bare /proof with the feed unreachable says so, with the form below", async ({ page }) => {
    await page.route(`${CHALLENGE_URL}/round`, (route) => route.abort("connectionrefused"));
    await open(page, "/proof");
    await expect(page.getByTestId("proof-open-lead")).toContainText(
      "The Challenge feed is not answering",
    );
    await expect(region(page, "Open a Vault by id").getByLabel("Vault id")).toBeVisible();
  });
});

test.describe("Address recompute", () => {
  const addresses = (page: Page) => region(page, "Addresses");
  const recomputeButton = (page: Page) =>
    addresses(page).getByRole("button", { name: "Recompute", exact: true });
  const vaultView = (page: Page) => page.getByTestId("recompute-vault");
  const live = (page: Page) => page.getByTestId("live-region");
  /** Every RPC view method the page called. */
  const methods = (requests: Request[]) =>
    requests
      .filter((r) => r.url().startsWith(RPC_URL) && r.method() === "POST")
      .map((r) => (r.postDataJSON() as { params: Record<string, string> }).params.method_name);

  async function expectGreen(page: Page) {
    const view = vaultView(page);
    const address = view.getByTestId("address-check");
    await expect(address).toHaveAttribute("data-match", "true");
    await expect(address.getByTestId("address-check-text")).toHaveText(
      `${PROOF_VAULT_ADDRESS} matches the funded Vault Address ${PROOF_VAULT_ADDRESS}`,
    );
    await expect(address.getByTestId("address-check-text")).toHaveCSS("color", OK);
    await expect(address.getByText("Match", { exact: true })).toBeVisible();
    const script = view.getByTestId("script-check");
    await expect(script).toHaveAttribute("data-match", "true");
    await expect(script.getByTestId("script-check-text")).toHaveText(
      "The script encodes the Owner key, the Co-signer key, 2 Guardian keys in Policy order and the Escape Timelock of 26,280 blocks, as get_vault states them.",
    );
    await expect(script.getByTestId("script-check-text")).toHaveCSS("color", OK);
    await expect(view.locator("[data-testid=script-row][data-differs=true]")).toHaveCount(0);
    await expect(view.getByTestId("kit-check")).toHaveAttribute("data-match", "true");
  }

  async function expectRed(page: Page, element: string) {
    const view = vaultView(page);
    const address = view.getByTestId("address-check");
    await expect(address).toHaveAttribute("data-match", "false");
    const text = address.getByTestId("address-check-text");
    await expect(text).toContainText(
      `does not match the funded Vault Address ${PROOF_VAULT_ADDRESS}`,
    );
    await expect(text).toHaveCSS("color", ALARM);
    // The differing address is shown in full: a P2WSH address on signet, not the funded one.
    const recomputed = (await view.getByTestId("address-recomputed").textContent()) ?? "";
    expect(recomputed).toMatch(/^tb1q[02-9ac-hj-np-z]{58}$/);
    expect(recomputed).not.toBe(PROOF_VAULT_ADDRESS);
    await expect(text).toContainText(recomputed);
    await expect(address.getByText("No match", { exact: true })).toBeVisible();
    const script = view.getByTestId("script-check");
    await expect(script).toHaveAttribute("data-match", "false");
    await expect(script.getByTestId("script-check-text")).toContainText(element);
    await expect(script.getByTestId("script-check-text")).toHaveCSS("color", ALARM);
  }

  test("Recompute decodes the script with its three paths and matches the funded Vault Address", async ({
    page,
  }) => {
    const { requests, fired } = await open(page, "/proof/7");
    await expect(page.getByTestId("proof-code-hash")).toHaveText(CODE_HASH);
    // Nothing is claimed, and the kit is not read, before Recompute runs.
    await expect(page.getByTestId("recompute-vault")).toHaveCount(0);
    await expect(addresses(page)).not.toContainText("matches the funded");
    expect(methods(requests)).not.toContain("get_vault_kit");

    await recomputeButton(page).click();
    await expectGreen(page);
    expect(methods(requests).filter((m) => m === "get_vault_kit")).toHaveLength(1);

    // The three paths, labelled.
    const paths = vaultView(page).getByTestId("script-paths");
    await expect(paths.locator("[data-path=withdrawal]")).toHaveText("WithdrawalOwner + Co-signer");
    await expect(paths.locator("[data-path=clawback]")).toHaveText(
      "ClawbackCo-signer + 1 of 2 Guardians",
    );
    await expect(paths.locator("[data-path=escape]")).toHaveText(
      "EscapeOwner after the CSV of 26,280 blocks",
    );
    // One monospace row per element, with its offset, keys in full, role and path.
    const rows = vaultView(page).getByTestId("script-row");
    await expect(rows).toHaveCount(22);
    await expect(rows.first()).toContainText("OP_IF");
    await expect(rows.first()).toContainText("IF · Withdrawal");
    const owner = vaultView(page).locator("[data-testid=script-row][data-offset='1']");
    await expect(owner).toContainText(PROOF_VAULT.owner_key);
    await expect(owner).toContainText("Owner key · Withdrawal");
    await expect(
      vaultView(page).locator("[data-testid=script-row][data-path=clawback]"),
    ).toHaveCount(9);
    await expect(vaultView(page).getByTestId("script-rows")).toContainText(
      "Guardian key 2 · watcher.morrow.testnet · Clawback",
    );
    await expect(vaultView(page).getByTestId("script-rows")).toContainText(
      "Escape Timelock · 26,280 blocks · Escape",
    );
    await expect(vaultView(page).getByTestId("script-rows")).toHaveCSS("font-family", /Geist Mono/);
    // Every script byte, in order.
    const hex = await vaultView(page)
      .getByTestId("script-byte")
      .evaluateAll((els) => els.map((el) => el.textContent).join(""));
    expect(hex).toBe(PROOF_VAULT_SCRIPT);
    await expect(live(page)).toHaveText(
      "Vault Address recomputed: the recomputed address matches the funded Vault Address. Script check: the script encodes the keys and timelock get_vault states.",
    );

    // Still one orange primary; Flip and Reset are secondary (off hover, which tints it).
    // The button's colour transition back from hover takes a moment: poll.
    await page.mouse.move(0, 0);
    await expect.poll(() => orangeElements(page)).toEqual(["Recompute"]);
    await expect(page.locator("main [data-variant=primary]")).toHaveCount(1);
    expect(await fired()).toEqual([]);
  });

  test("Flip a byte turns both checks red with text, Reset brings back the green match", async ({
    page,
  }) => {
    const { fired, requests } = await open(page, "/proof/7");
    await recomputeButton(page).click();
    await expectGreen(page);

    const flip = vaultView(page).getByRole("button", { name: "Flip a byte" });
    await flip.click();
    await expectRed(page, "Owner key differs at byte 1");
    // The Owner key's last byte (34), 7a XOR 01, in a highlighted labelled row.
    const byte = vaultView(page).locator("[data-testid=script-byte][data-offset='34']");
    await expect(byte).toHaveText("7b");
    await expect(byte).toHaveAttribute("aria-pressed", "true");
    const owner = vaultView(page).locator("[data-testid=script-row][data-offset='1']");
    await expect(owner).toHaveAttribute("data-flipped", "true");
    await expect(owner).toContainText(`02${"7a".repeat(31)}7b`);
    await expect(owner).toContainText("Owner key");
    await expect(owner).toContainText("differs from the template");
    await expect(live(page)).toContainText(
      "Byte 34 flipped: the recomputed address does not match the funded Vault Address. Script check: Owner key differs.",
    );
    // The pressed button is spent; focus moved on to Reset.
    await expect(flip).toBeDisabled();
    const reset = vaultView(page).getByRole("button", { name: "Reset" });
    await expect(reset).toBeFocused();

    await reset.click();
    await expectGreen(page);
    await expect(byte).toHaveText("7a");
    await expect(live(page)).toContainText("Reset to the published script");
    // Reset is spent in turn; focus goes back to Flip a byte.
    await expect(reset).toBeDisabled();
    await expect(flip).toBeFocused();

    // A second Recompute starts over: earlier flips are cleared.
    await vaultView(page).locator("[data-testid=script-byte][data-offset='40']").click();
    await expectRed(page, "Co-signer key differs");
    await recomputeButton(page).click();
    await expectGreen(page);
    await expect(
      vaultView(page).locator("[data-testid=script-byte][aria-pressed=true]"),
    ).toHaveCount(0);
    // The kit is read once for Recompute twice and the Allowance row.
    await addresses(page).getByRole("button", { name: "Recompute the Allowance Address" }).click();
    await expect(page.getByTestId("recompute-allowance")).toBeVisible();
    expect(methods(requests).filter((m) => m === "get_vault_kit")).toHaveLength(1);
    expect(await fired()).toEqual([]);
  });

  test("clicking a byte flips it; the byte view is reachable by keyboard", async ({ page }) => {
    await open(page, "/proof/7");
    await recomputeButton(page).click();
    await expectGreen(page);

    const byte40 = vaultView(page).locator("[data-testid=script-byte][data-offset='40']");
    await expect(byte40).toHaveText("c3");
    await byte40.click();
    await expect(byte40).toHaveText("c2");
    await expectRed(page, "Co-signer key differs at byte 36");
    await expect(
      vaultView(page).locator("[data-testid=script-row][data-offset='36']"),
    ).toHaveAttribute("data-flipped", "true");
    // Selecting it again flips it back.
    await byte40.click();
    await expectGreen(page);

    // One Tab stop for the bytes; arrows move, Enter flips.
    const box = await byte40.boundingBox();
    expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    await byte40.focus();
    await page.keyboard.press("ArrowRight");
    const byte41 = vaultView(page).locator("[data-testid=script-byte][data-offset='41']");
    await expect(byte41).toBeFocused();
    await expect(byte41).toHaveAttribute("tabindex", "0");
    await expect(byte40).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("Enter");
    await expect(byte41).toHaveAttribute("aria-pressed", "true");
    await expectRed(page, "Co-signer key differs");
    await page.keyboard.press("Home");
    await expect(
      vaultView(page).locator("[data-testid=script-byte][data-offset='0']"),
    ).toBeFocused();
    await page.keyboard.press("End");
    const last = vaultView(page).locator("[data-testid=script-byte][data-offset='221']");
    await expect(last).toBeFocused();
    await expect(last).toHaveText("68");
    await page.keyboard.press("Space");
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await expect(last).toHaveText("69");
    await expect(live(page)).toContainText("Byte 221 flipped");
    await expect(vaultView(page).getByRole("toolbar", { name: "Script bytes" })).toBeVisible();
  });

  test("a tampered kit fails the script check by name and the address check", async ({ page }) => {
    const otherOwner = `03${"99".repeat(32)}`;
    await routeRpc(page, (params, args) =>
      params.method_name === "get_vault_kit" && args.vault_id === "7"
        ? viewOk({
            ...PROOF_KIT,
            vault_script_hex: vaultScriptHex(otherOwner, PROOF_VAULT.cosigner_pubkeys.vault),
          })
        : undefined,
    );
    await open(page, "/proof/7");
    await recomputeButton(page).click();
    await expectRed(page, "Owner key differs at byte 1");
    await expect(
      vaultView(page).locator("[data-testid=script-row][data-offset='1']"),
    ).toContainText(otherOwner);
  });

  test("a kit read that fails says so, with a retry that reads it", async ({ page }) => {
    let fail = true;
    await routeRpc(page, (params) =>
      params.method_name === "get_vault_kit" && fail
        ? { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} } } }
        : undefined,
    );
    await open(page, "/proof/7");
    await recomputeButton(page).click();
    const failed = page.getByTestId("recompute-failed");
    await expect(failed).toContainText("Could not read the Vault Kit");
    await expect(vaultView(page)).toHaveCount(0);
    await expect(live(page)).toHaveText("Could not read the Vault Kit");
    fail = false;
    await failed.getByRole("button", { name: "Retry" }).click();
    await expectGreen(page);
    await expect(failed).toHaveCount(0);
  });

  test("Retry after a failed Allowance read opens the Allowance view", async ({ page }) => {
    let fail = true;
    await routeRpc(page, (params) =>
      params.method_name === "get_vault_kit" && fail
        ? { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: {} } } }
        : undefined,
    );
    await open(page, "/proof/7");
    const toggle = addresses(page).getByRole("button", { name: "Recompute the Allowance Address" });
    await toggle.click();
    const failed = page.getByTestId("recompute-failed");
    await expect(failed).toContainText("Could not read the Vault Kit");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    fail = false;
    await failed.getByRole("button", { name: "Retry" }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByTestId("recompute-allowance").getByTestId("address-check"),
    ).toHaveAttribute("data-match", "true");
    await expect(vaultView(page)).toHaveCount(0);
  });

  test("a Vault without keys has no script: Recompute is unavailable and says why", async ({
    page,
  }) => {
    await routeRpc(
      page,
      vaultSeven({
        ...PROOF_VAULT,
        state: "pending_keys",
        addresses: null,
        cosigner_pubkeys: null,
        pending_change: null,
      }),
    );
    const { requests } = await open(page, "/proof/7");
    await expect(page.getByTestId("recompute-unavailable")).toHaveText(
      "This Vault has no script yet, so there is nothing to recompute.",
    );
    await expect(addresses(page).getByRole("button")).toHaveCount(0);
    expect(await orangeElements(page)).toEqual([]);
    expect(methods(requests)).not.toContain("get_vault_kit");
  });

  test("the Allowance Address gets the same recompute in a collapsed second row", async ({
    page,
  }) => {
    await open(page, "/proof/7");
    // The Vault's view first, so the Allowance's flip can be seen to leave it alone.
    await recomputeButton(page).click();
    await expectGreen(page);
    const toggle = addresses(page).getByRole("button", { name: "Recompute the Allowance Address" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("recompute-allowance")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(live(page)).toHaveText(
      "Allowance Address recomputed: the recomputed address matches the funded Allowance Address. Script check: the script encodes the keys and timelock get_vault states.",
    );
    const view = page.getByTestId("recompute-allowance");
    await expect(view.getByTestId("address-check")).toHaveAttribute("data-match", "true");
    await expect(view.getByTestId("address-check-text")).toHaveText(
      `${PROOF_ALLOWANCE_ADDRESS} matches the funded Allowance Address ${PROOF_ALLOWANCE_ADDRESS}`,
    );
    await expect(view.getByTestId("script-check")).toHaveAttribute("data-match", "true");
    await expect(view.locator("[data-testid=script-row][data-offset='36']")).toContainText(
      PROOF_VAULT.cosigner_pubkeys.allowance,
    );
    // Its own Flip a byte; the Vault's view stays green.
    await view.getByRole("button", { name: "Flip a byte" }).click();
    await expect(view.getByTestId("address-check")).toHaveAttribute("data-match", "false");
    await expect(live(page)).toHaveText(
      "Byte 34 flipped: the recomputed address does not match the funded Allowance Address. Script check: Owner key differs.",
    );
    await expectGreen(page);
    await toggle.click();
    await expect(page.getByTestId("recompute-allowance")).toBeHidden();
  });

  test("with reduced motion the checks and rows change without a transition", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await open(page, "/proof/7");
    await recomputeButton(page).click();
    await expectGreen(page);
    const durations = () =>
      vaultView(page)
        .locator("[data-testid=script-row], [data-testid=address-check], [data-testid=script-byte]")
        .evaluateAll((els) => [
          ...new Set(els.map((el) => getComputedStyle(el).transitionDuration)),
        ]);
    // By default the colours ease; with reduced motion they change at once.
    expect(await durations()).toEqual(["0.3s"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(durations).toEqual(["0s"]);
  });
});
