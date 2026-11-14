import { expect, test, type APIResponse } from "@playwright/test";
import { BACKEND_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// NFR-10 against the production server: every response carries the strict CSP and the
// transport headers, and no route trips the CSP in Chromium.

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; " +
  `connect-src 'self' ${RPC_URL} ${BACKEND_URL} ${WATCHER_URL}; ` +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The wallet pages' CSP (story 1.11b) for a response's nonce. */
const walletCsp = (nonce: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
  "font-src 'self'; img-src 'self' data:; frame-src 'self' https://wallet.intear.tech; " +
  `connect-src 'self' ${RPC_URL} ${BACKEND_URL} ${WATCHER_URL} ` +
  "https://*.meteorwallet.app wss://*.meteorwallet.app https://test.rpc.fastnear.com https://archival-rpc.testnet.near.org https://wallet.intear.tech wss://*.intear.tech; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const NONCE_META = /<meta name="csp-nonce" content="([A-Za-z0-9+/]{22}==)" \/>/;

function expectSecurityHeaders(response: APIResponse) {
  const headers = response.headers();
  expect(headers["content-security-policy"]).toBe(CSP);
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
}

test.describe("security headers", () => {
  for (const path of ["/challenge", "/g/1"]) {
    test(`${path} serves index.html with every header, no-store`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/^text\/html/);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expect(await response.text()).toContain('<div id="root">');
      expectSecurityHeaders(response);
    });
  }

  test("a hashed asset is immutable and carries every header", async ({ request }) => {
    const html = await (await request.get("/challenge")).text();
    const script = /<script[^>]*\bsrc="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (script === undefined) throw new Error("index.html loads no /assets script");
    const response = await request.get(script);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/^text\/javascript/);
    expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(response);
  });

  test("/config.json is the whitelist, no-store, with every header", async ({ request }) => {
    const response = await request.get("/config.json");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expectSecurityHeaders(response);
    expect(await response.json()).toEqual({
      near_network: "testnet",
      vault_contract: "vault.morrow.testnet",
      near_rpc_url: RPC_URL,
      near_archival_rpc_url: RPC_URL,
      near_tx_indexer_url: `${RPC_URL}/fastnear`,
      btc_network: "signet",
      btc_backend_url: BACKEND_URL,
      watcher_url: WATCHER_URL,
      challenge_url: null,
      bounty_url: null,
    });
  });

  for (const path of ["/vault/new", "/vault/7"]) {
    test(`${path} gets the wallet CSP with a fresh nonce, also in the page`, async ({
      request,
    }) => {
      const first = await request.get(path);
      const second = await request.get(path);
      const nonces: string[] = [];
      for (const response of [first, second]) {
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toBe("no-store");
        const nonce = NONCE_META.exec(await response.text())?.[1];
        if (nonce === undefined) throw new Error("no csp-nonce meta");
        nonces.push(nonce);
        expect(response.headers()["content-security-policy"]).toBe(walletCsp(nonce));
        expect(response.headers()["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains",
        );
      }
      expect(nonces[0]).not.toBe(nonces[1]);
    });
  }

  test("the pinned wallet executors are served from our origin with the strict CSP", async ({
    request,
  }) => {
    for (const path of ["/wallets/meteor.js", "/wallets/intear.js"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/^text\/javascript/);
      expectSecurityHeaders(response);
    }
  });

  test("/vault and every other route keep today's strict CSP and no nonce", async ({ request }) => {
    for (const path of ["/vault", "/vault/abc", "/proof/7", "/xray", "/lost", "/"]) {
      const response = await request.get(path);
      expectSecurityHeaders(response);
      expect(await response.text()).not.toContain("csp-nonce");
    }
  });

  for (const path of ["/assets/nope.js", "/nope.css"]) {
    test(`${path} is a 404 with every header`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(response.headers()["cache-control"]).toBe("no-store");
      expectSecurityHeaders(response);
    });
  }
});

test.describe("no CSP violation on load", () => {
  for (const path of [
    "/",
    "/challenge",
    "/lost",
    "/proof",
    "/proof/7",
    "/xray",
    "/xray/7",
    "/g/1",
    "/nope",
    "/vault/new",
    "/vault/7",
  ]) {
    test(path, async ({ page }) => {
      const violations: string[] = [];
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
      const nonce = NONCE_META.exec((await response?.text()) ?? "")?.[1];
      expect(response?.headers()["content-security-policy"]).toBe(
        path.startsWith("/vault/") && nonce !== undefined ? walletCsp(nonce) : CSP,
      );
      if (path.startsWith("/vault/")) expect(nonce).toBeDefined();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByTestId("live-region")).toBeAttached();

      const fired = await page.evaluate(
        () => (window as unknown as { cspViolations: string[] }).cspViolations,
      );
      expect(fired).toEqual([]);
      expect(violations).toEqual([]);
    });
  }
});
