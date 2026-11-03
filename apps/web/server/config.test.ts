import { describe, expect, it } from "vitest";
import {
  ConfigError,
  connectSources,
  contentSecurityPolicy,
  loadConfig,
  securityHeaders,
} from "./config.ts";

const VALID = {
  MORROW_NEAR_NETWORK: "testnet",
  MORROW_VAULT_CONTRACT: "vault.morrow.testnet",
  MORROW_BTC_NETWORK: "signet",
  MORROW_BTC_BACKEND_URL: "https://mempool.space/signet/api",
  MORROW_WATCHER_URL: "https://watcher.example.org",
};

/** The `ConfigError` `loadConfig` throws for `env`. */
function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("loadConfig accepted the env");
}

describe("loadConfig", () => {
  it("returns exactly the whitelist, with the network's default RPC", () => {
    const config = loadConfig({ ...VALID, PATH: "/usr/bin", MORROW_SECRET: "x", HOME: "/root" });
    expect(config).toEqual({
      near_network: "testnet",
      vault_contract: "vault.morrow.testnet",
      near_rpc_url: "https://rpc.testnet.fastnear.com",
      btc_network: "signet",
      btc_backend_url: "https://mempool.space/signet/api",
      watcher_url: "https://watcher.example.org",
      challenge_url: null,
      bounty_url: null,
    });
  });

  it("reads the optional challenge feed and bounty link", () => {
    const config = loadConfig({
      ...VALID,
      MORROW_CHALLENGE_URL: "https://challenge.example.org/feed/",
      MORROW_BOUNTY_URL: "https://bounty.example.org/bounty",
    });
    expect(config.challenge_url).toBe("https://challenge.example.org/feed");
    expect(config.bounty_url).toBe("https://bounty.example.org/bounty");
    expect(loadConfig({ ...VALID, MORROW_CHALLENGE_URL: " " }).challenge_url).toBeNull();
  });

  it("uses the mainnet RPC on mainnet and none for the mock contract", () => {
    expect(loadConfig({ ...VALID, MORROW_NEAR_NETWORK: "mainnet" }).near_rpc_url).toBe(
      "https://rpc.mainnet.fastnear.com",
    );
    expect(loadConfig({ ...VALID, MORROW_NEAR_NETWORK: "mock" }).near_rpc_url).toBeNull();
  });

  it("takes MORROW_NEAR_RPC_URL over the default and leaves the watcher optional", () => {
    const config = loadConfig({
      ...VALID,
      MORROW_NEAR_RPC_URL: "https://rpc.example.org/near/",
      MORROW_WATCHER_URL: undefined,
    });
    expect(config.near_rpc_url).toBe("https://rpc.example.org/near");
    expect(config.watcher_url).toBeNull();
    expect(loadConfig({ ...VALID, MORROW_WATCHER_URL: "  " }).watcher_url).toBeNull();
  });

  it("allows http on localhost only", () => {
    for (const host of ["localhost:3000", "127.0.0.1:4174", "[::1]:8080"]) {
      expect(
        loadConfig({ ...VALID, MORROW_BTC_BACKEND_URL: `http://${host}` }).btc_backend_url,
      ).toBe(`http://${host}`);
    }
    expect(failure({ ...VALID, MORROW_BTC_BACKEND_URL: "http://mempool.space/api" }).variable).toBe(
      "MORROW_BTC_BACKEND_URL",
    );
    expect(failure({ ...VALID, MORROW_WATCHER_URL: "http://localhost.evil.org" }).variable).toBe(
      "MORROW_WATCHER_URL",
    );
  });

  it.each([
    ["MORROW_NEAR_NETWORK", { MORROW_NEAR_NETWORK: undefined }],
    ["MORROW_NEAR_NETWORK", { MORROW_NEAR_NETWORK: "betanet" }],
    ["MORROW_VAULT_CONTRACT", { MORROW_VAULT_CONTRACT: "" }],
    ["MORROW_VAULT_CONTRACT", { MORROW_VAULT_CONTRACT: "Vault.Testnet" }],
    ["MORROW_VAULT_CONTRACT", { MORROW_VAULT_CONTRACT: "a" }],
    ["MORROW_BTC_NETWORK", { MORROW_BTC_NETWORK: undefined }],
    ["MORROW_BTC_NETWORK", { MORROW_BTC_NETWORK: "mainnet" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: undefined }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "not a url" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "https://user:pw@mempool.space/api" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "https://token@mempool.space/api" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "https://mempool.space/api?key=1" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "https://mempool.space/api?" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "https://mempool.space/api#x" }],
    ["MORROW_BTC_BACKEND_URL", { MORROW_BTC_BACKEND_URL: "ftp://mempool.space/api" }],
    ["MORROW_NEAR_RPC_URL", { MORROW_NEAR_RPC_URL: "http://rpc.testnet.near.org" }],
    ["MORROW_WATCHER_URL", { MORROW_WATCHER_URL: "javascript:alert(1)" }],
    ["MORROW_CHALLENGE_URL", { MORROW_CHALLENGE_URL: "http://challenge.example.org" }],
    ["MORROW_CHALLENGE_URL", { MORROW_CHALLENGE_URL: "https://user:pw@challenge.example.org" }],
    ["MORROW_BOUNTY_URL", { MORROW_BOUNTY_URL: "not a url" }],
    ["MORROW_BOUNTY_URL", { MORROW_BOUNTY_URL: "https://bounty.example.org/?key=1" }],
  ])("rejects a bad %s and never echoes the value", (variable, override) => {
    const env = { ...VALID, ...override };
    const error = failure(env);
    expect(error.variable).toBe(variable);
    expect(error.message).toContain(variable);
    const value = (override as Record<string, string | undefined>)[variable];
    // Values too short to tell apart from ordinary words (`a`) are skipped.
    if (value !== undefined && value.length >= 4) expect(error.message).not.toContain(value);
    expect(error.message).not.toMatch(/pw|key=1|token/);
  });
});

describe("content security policy", () => {
  it("allows 'self' plus exactly the three configured origins", () => {
    const config = loadConfig({
      ...VALID,
      MORROW_NEAR_RPC_URL: "https://rpc.example.org:8443/near",
    });
    expect(connectSources(config)).toEqual([
      "'self'",
      "https://rpc.example.org:8443",
      "https://mempool.space",
      "https://watcher.example.org",
    ]);
    expect(contentSecurityPolicy(config)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; " +
        "connect-src 'self' https://rpc.example.org:8443 https://mempool.space https://watcher.example.org; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  it("adds the challenge feed's origin, never the bounty link's", () => {
    const config = loadConfig({
      ...VALID,
      MORROW_CHALLENGE_URL: "https://challenge.example.org:8443/feed",
      MORROW_BOUNTY_URL: "https://bounty.example.org",
    });
    expect(connectSources(config)).toEqual([
      "'self'",
      "https://rpc.testnet.fastnear.com",
      "https://mempool.space",
      "https://watcher.example.org",
      "https://challenge.example.org:8443",
    ]);
    expect(contentSecurityPolicy(config)).not.toContain("bounty.example.org");
  });

  it("drops unset services and repeated origins", () => {
    const config = loadConfig({
      ...VALID,
      MORROW_NEAR_NETWORK: "mock",
      MORROW_WATCHER_URL: "https://mempool.space/watcher",
    });
    expect(connectSources(config)).toEqual(["'self'", "https://mempool.space"]);
  });

  it("never allows inline script, eval or a wildcard", () => {
    const csp = contentSecurityPolicy(loadConfig(VALID));
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:/);
  });

  it("comes with HSTS, nosniff and no-referrer", () => {
    expect(securityHeaders(loadConfig(VALID))).toMatchObject({
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
  });
});
