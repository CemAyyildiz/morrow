import { expect, test, type APIResponse } from "@playwright/test";
import { BACKEND_URL, RPC_URL, WATCHER_URL } from "./services.ts";

// NFR-10 against the production server: every response carries the strict CSP and the
// transport headers, and no route trips the CSP in Chromium.

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; " +
  `connect-src 'self' ${RPC_URL} ${BACKEND_URL} ${WATCHER_URL}; ` +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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
      btc_network: "signet",
      btc_backend_url: BACKEND_URL,
      watcher_url: WATCHER_URL,
    });
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
  for (const path of ["/challenge", "/vault", "/g/1", "/nope"]) {
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
      expect(response?.headers()["content-security-policy"]).toBe(CSP);
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
