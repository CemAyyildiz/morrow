import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PROOF_VAULT_ADDRESS } from "./proof-fixture.ts";

// Story 1.11b: the wallet pages against the production build. A stand-in wallet is injected the
// way a browser-extension wallet announces itself to near-connect (`near-wallet-injected`), so
// the wizard can be connected without a real wallet; its `signAndSendTransaction` records the
// call and answers with Vault #7, which the stub RPC serves as active.

const ACCOUNT = "e2e-owner.testnet";
const SIGNET_ADDRESS = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const MAINNET_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

interface WalletCall {
  receiverId: string;
  actions: {
    type: string;
    params: { methodName: string; args: unknown; gas: string; deposit: string };
  }[];
}

/** Injects the stand-in wallet before the page loads. */
async function injectWallet(page: Page, reject = false) {
  await page.addInitScript(
    ([account, rejects]) => {
      const calls: unknown[] = [];
      (window as unknown as { walletCalls: unknown[] }).walletCalls = calls;
      const wallet = {
        manifest: {
          id: "e2e-wallet",
          name: "E2E Wallet",
          icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          description: "Stand-in wallet",
          website: "https://example.org",
          version: "1.0.0",
          executor: "",
          type: "injected",
          platform: [],
          permissions: {},
          features: { signAndSendTransaction: true, signInWithoutAddKey: true, testnet: true },
        },
        signIn: async () => [{ accountId: account }],
        signOut: async () => undefined,
        getAccounts: async () => [{ accountId: account }],
        signAndSendTransaction: async (params: unknown) => {
          calls.push(params);
          if (rejects) throw new Error("User rejected");
          return {
            status: { SuccessValue: btoa('"7"') },
            transaction: { hash: "E2EHASH" },
            transaction_outcome: { id: "E2EHASH", outcome: { logs: [] } },
            receipts_outcome: [],
          };
        },
      };
      window.addEventListener("near-selector-ready", () =>
        window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })),
      );
    },
    [ACCOUNT, reject] as const,
  );
}

/** Connects the stand-in wallet and fills the wizard up to Create. */
async function fillWizard(page: Page) {
  await page.getByTestId("wallet-connect").click();
  await page.locator('.hot-connector-popup .connect-item[data-type="e2e-wallet"]').click();
  await expect(page.getByTestId("wallet-account")).toHaveText(`Connected as ${ACCOUNT}`);
  await page.getByTestId("recovery-address").fill(SIGNET_ADDRESS);
  await page.getByTestId("recovery-retype").fill(SIGNET_ADDRESS.slice(-6));
  await Promise.all([page.waitForEvent("download"), page.getByTestId("download-keys").click()]);
  await expect(page.getByTestId("create-vault")).not.toHaveAttribute("aria-disabled", "true");
}

/** Opens a wallet page and records CSP violations, as the headers spec does. */
async function open(page: Page, path: string) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

test("the Vault nav item is a full page load into /vault/new", async ({ page }, info) => {
  await open(page, "/challenge");
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  if (info.project.name === "phone") {
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Vault" }).click();
  } else {
    await page.getByTestId("sidebar").getByRole("link", { name: "Vault" }).click();
  }
  await expect(page).toHaveURL(/\/vault\/new$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Create a Vault");
  // A new document: the marker set on /challenge is gone, and the nonce meta is there.
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(
    undefined,
  );
  await expect(page.locator('meta[name="csp-nonce"]')).toHaveCount(1);
  // And back out: the home link is a full page load too, to a page without the nonce.
  await page.getByTestId("back-link").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('meta[name="csp-nonce"]')).toHaveCount(0);
});

test("/vault redirects to /vault/new with a full page load", async ({ page }) => {
  await open(page, "/vault");
  await expect(page).toHaveURL(/\/vault\/new$/);
  await expect(page.locator('meta[name="csp-nonce"]')).toHaveCount(1);
});

test("/vault/new without a wallet: only Connect is actionable", async ({ page }) => {
  await open(page, "/vault/new");
  await expect(page).toHaveTitle("Vault · morrow");
  await expect(page.getByTestId("wallet-connect")).toHaveText("Connect a NEAR wallet");
  await expect(page.getByTestId("wallet-connect")).not.toHaveAttribute("aria-disabled", "true");
  for (const id of ["create-vault", "download-keys", "generate-recovery"]) {
    await expect(page.getByTestId(id)).toHaveAttribute("aria-disabled", "true");
  }
  await expect(page.getByTestId("create-missing")).toContainText("Connect a NEAR wallet.");
  // Nothing loaded the wallet library, and no third-party origin was asked.
  expect(await violations(page)).toEqual([]);
  // One orange action: Connect.
  await expect(page.locator('[data-variant="primary"]')).toHaveCount(1);
  await expect(page.locator('[data-variant="primary"]')).toHaveText("Connect a NEAR wallet");
});

test("/vault/new: axe finds no violation", async ({ page }) => {
  await open(page, "/vault/new");
  const { violations: found } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(found.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
});

test("/vault/new: connect, gate Create on the address, the re-type and the download, then create", async ({
  page,
}) => {
  await injectWallet(page);
  await open(page, "/vault/new");

  // The picker lists the pinned wallets and the injected one; no CSP violation opening it.
  await page.getByTestId("wallet-connect").click();
  const picker = page.locator(".hot-connector-popup");
  await expect(picker.locator('.connect-item[data-type="meteor-wallet"]')).toBeVisible();
  await expect(picker.locator('.connect-item[data-type="intear-wallet"]')).toBeVisible();
  await picker.locator('.connect-item[data-type="e2e-wallet"]').click();
  await expect(page.getByTestId("wallet-account")).toHaveText(`Connected as ${ACCOUNT}`);
  expect(await violations(page)).toEqual([]);

  const create = page.getByTestId("create-vault");
  const missing = page.getByTestId("create-missing");
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(missing).not.toContainText("Connect a NEAR wallet.");

  // A mainnet address: refused inline.
  await page.getByTestId("recovery-address").fill(MAINNET_ADDRESS);
  await expect(page.getByTestId("recovery-error")).toHaveText("This is not a signet address.");
  await expect(missing).toContainText("Enter a signet Recovery Address.");
  await expect(create).toHaveAttribute("aria-disabled", "true");

  // A signet address and a wrong re-type, then the right one.
  await page.getByTestId("recovery-address").fill(SIGNET_ADDRESS);
  await expect(page.getByTestId("recovery-error")).toHaveCount(0);
  await page.getByTestId("recovery-retype").fill("xxxxxx");
  await expect(page.getByTestId("retype-error")).toBeVisible();
  await page.getByTestId("recovery-retype").fill(SIGNET_ADDRESS.slice(-6));
  await expect(page.getByTestId("retype-error")).toHaveCount(0);
  await expect(missing).toHaveText(/Download the key file\./);
  await expect(missing).not.toContainText("Recovery Address");
  await expect(create).toHaveAttribute("aria-disabled", "true");

  // The key file: downloaded from memory, with the connected account and no test key.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-keys").click(),
  ]);
  expect(download.suggestedFilename()).toBe("morrow-vault-keys.json");
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(file).toMatchObject({
    kind: "morrow-vault-keys",
    version: 1,
    near_network: "testnet",
    vault_contract: "vault.morrow.testnet",
    btc_network: "signet",
    owner_account: ACCOUNT,
  });
  expect(file).not.toHaveProperty("recovery_secret_wif");
  for (const field of ["owner_secret_hex", "guardian_secret_hex", "watcher_x25519_sk_hex"]) {
    expect(file[field]).toMatch(/^[0-9a-f]{64}$/);
  }
  await expect(page.getByTestId("keys-downloaded")).toBeVisible();
  await expect(missing).toHaveCount(0);
  await expect(create).not.toHaveAttribute("aria-disabled", "true");
  // One orange action: Create, now that Connect is done.
  await expect(page.locator('[data-variant="primary"]')).toHaveText("Create Vault");

  // A test Recovery Address changes the key file: the download no longer counts.
  await page.getByTestId("generate-recovery").click();
  await expect(page.getByTestId("recovery-address")).toHaveValue(/^tb1q/);
  await expect(missing).toContainText("Download the key file.");
  const generated = await page.getByTestId("recovery-address").inputValue();
  await page.getByTestId("recovery-retype").fill(generated.slice(-6));
  const [second] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-keys").click(),
  ]);
  const secondFile = JSON.parse(readFileSync(await second.path(), "utf8")) as Record<
    string,
    unknown
  >;
  expect(secondFile.recovery_secret_wif).toMatch(/^c[1-9A-HJ-NP-Za-km-z]{51}$/);
  await expect(create).not.toHaveAttribute("aria-disabled", "true");

  // Create: one create_vault through the wallet, 0.5 NEAR and 100 TGas, a signet Policy.
  await create.click();
  await expect(page).toHaveURL(/\/vault\/7$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vault #7");
  const calls = await page.evaluate(
    () => (window as unknown as { walletCalls: WalletCall[] }).walletCalls,
  );
  expect(calls).toHaveLength(1);
  const call = calls[0] as WalletCall;
  expect(call.receiverId).toBe("vault.morrow.testnet");
  expect(call.actions).toHaveLength(1);
  const action = call.actions[0] as WalletCall["actions"][number];
  expect(action.type).toBe("FunctionCall");
  expect(action.params).toMatchObject({
    methodName: "create_vault",
    gas: "100000000000000",
    deposit: "500000000000000000000000",
  });
  const args = action.params.args as {
    owner_key: string;
    policy: Record<string, unknown> & { guardians: Record<string, unknown>[] };
  };
  expect(args.owner_key).toMatch(/^0[23][0-9a-f]{64}$/);
  expect(args.policy).toMatchObject({
    delay_ns: "3600000000000",
    policy_change_delay_ns: "604800000000000",
    escape_timelock_blocks: 4320,
    recovery_address: generated,
    fee_cap_sats: "100000",
    allowance_limit_sats: "10000",
    fast_approval: false,
    btc_network: "signet",
  });
  expect(args.policy.guardians).toEqual([
    {
      guardian_key: expect.stringMatching(/^0[23][0-9a-f]{64}$/),
      guardian_account: ACCOUNT,
      kind: "backup_device",
    },
  ]);
  // The handed-over keys are this wizard's, not Vault #7's (the stub's): refused, nothing sent.
  await expect(page.getByTestId("keys-status")).toContainText("Refused");
  expect(await violations(page)).toEqual([]);
});

for (const [walletId, file] of [
  ["meteor-wallet", "/wallets/meteor.js"],
  ["intear-wallet", "/wallets/intear.js"],
] as const) {
  test(`/vault/new: the pinned ${walletId} executor runs from our origin under this page's nonce`, async ({
    page,
  }) => {
    // The wallets' own services stay unreached: only the executor's loading is checked.
    await page.route(
      (url) => /(^|\.)(meteorwallet\.app|intear\.tech)$/.test(url.hostname),
      (route) => route.abort(),
    );
    await open(page, "/vault/new");
    const nonce = await page.locator('meta[name="csp-nonce"]').getAttribute("content");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const executor = page.waitForRequest((request) => new URL(request.url()).pathname === file);
    await page.getByTestId("wallet-connect").click();
    await page.locator(`.hot-connector-popup .connect-item[data-type="${walletId}"]`).click();
    const request = await executor;
    expect(new URL(request.url()).origin).toBe(new URL(page.url()).origin);
    // near-connect injects the executor inline into its sandboxed srcdoc iframe, with this
    // page's nonce, so the inherited wallet CSP lets exactly that script run.
    await expect
      .poll(
        () =>
          page.evaluate(
            (expected) =>
              [...document.querySelectorAll("iframe[srcdoc]")].some((frame) => {
                const doc = frame.getAttribute("srcdoc") ?? "";
                return frame.getAttribute("sandbox") === "allow-scripts" && doc.includes(expected);
              }),
            `<script type="module" nonce="${nonce}">`,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
}

test("/vault/new: a wallet that rejects keeps the form", async ({ page }) => {
  await injectWallet(page, true);
  await open(page, "/vault/new");
  await fillWizard(page);
  await page.getByTestId("create-vault").click();
  await expect(page.getByTestId("create-outcome")).toHaveText(
    "The wallet did not send it: User rejected",
  );
  await expect(page.getByTestId("create-outcome")).toHaveAttribute("data-tone", "alarm");
  await expect(page.getByTestId("live-region")).toHaveText(
    "The wallet did not send it: User rejected",
  );
  await expect(page).toHaveURL(/\/vault\/new$/);
  await expect(page.getByTestId("recovery-address")).toHaveValue(SIGNET_ADDRESS);
  await expect(page.getByTestId("create-vault")).not.toHaveAttribute("aria-disabled", "true");
});

test("/vault/7: the Vault from NEAR, unfunded, every action disabled with its reason", async ({
  page,
}) => {
  await open(page, "/vault/7");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vault #7");
  await expect(page.getByTestId("vault-address-text")).toHaveText(PROOF_VAULT_ADDRESS);
  await expect(page.getByTestId("vault-balance")).toHaveText("0.00000000 BTC on signet");
  await expect(page.getByTestId("vault-unfunded")).toContainText("signet faucet");
  await expect(page.getByTestId("vault-facts")).toContainText("proof-owner.testnet");
  await expect(page.getByTestId("vault-facts")).toContainText("24 h");
  for (const [button, reason] of [
    ["withdraw-request", "withdraw-reason"],
    ["withdraw-execute", "execute-reason"],
    ["clawback", "clawback-reason"],
  ] as const) {
    await expect(page.getByTestId(button)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId(reason)).toHaveText("Connect a NEAR wallet first.");
  }
  // The Proof Page link leaves the wallet pages with a full page load.
  await expect(page.getByRole("link", { name: "Open its Proof Page" })).toHaveAttribute(
    "href",
    "/proof/7",
  );
  expect(await violations(page)).toEqual([]);
});

test("/vault/7: a key file for another Vault is refused with its reason", async ({ page }) => {
  await open(page, "/vault/7");
  const file = {
    kind: "morrow-vault-keys",
    version: 1,
    near_network: "testnet",
    vault_contract: "vault.morrow.testnet",
    btc_network: "signet",
    owner_account: "proof-owner.testnet",
    owner_secret_hex: "11".repeat(32),
    guardian_secret_hex: "22".repeat(32),
    watcher_x25519_sk_hex: "33".repeat(32),
    vault_id: "8",
  };
  await page.getByTestId("load-keys").setInputFiles({
    name: "keys.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await expect(page.getByTestId("keys-status")).toHaveText(
    "Refused: this key file is for another Vault. Nothing was sent.",
  );
  await page.getByTestId("load-keys").setInputFiles({
    name: "keys.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...file, vault_id: "7" })),
  });
  await expect(page.getByTestId("keys-status")).toHaveText(
    "Refused: this key file's Owner Key is not this Vault's. Nothing was sent.",
  );
  await page.getByTestId("load-keys").setInputFiles({
    name: "keys.json",
    mimeType: "application/json",
    buffer: Buffer.from("not json"),
  });
  await expect(page.getByTestId("keys-status")).toHaveText(
    "Refused: this is not a Morrow Vault key file. Nothing was sent.",
  );
});

test("/vault/8: a Vault NEAR does not know is refused verbatim, with Retry", async ({ page }) => {
  await open(page, "/vault/8");
  await expect(page.getByTestId("vault-read")).toHaveAttribute("data-state", "refused");
  await expect(page.getByTestId("vault-read")).toContainText(
    "Refused · ERR_VAULT_NOT_FOUND · No Vault exists with this id.",
  );
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
