import { describe, expect, it, vi } from "vitest";
import { contractStateFrom, heartbeatFrom, heartbeatUrl, parseConfig, withTimeout } from "./live";

const CONFIG = {
  near_network: "testnet",
  vault_contract: "vault.morrow.testnet",
  near_rpc_url: "https://rpc.testnet.near.org",
  btc_network: "signet",
  btc_backend_url: "https://mempool.space/signet/api",
  watcher_url: "https://watcher.example.org",
};

const fullAccess = { public_key: "ed25519:a", access_key: { nonce: 1, permission: "FullAccess" } };
const functionCall = {
  public_key: "ed25519:b",
  access_key: {
    nonce: 2,
    permission: {
      FunctionCall: { allowance: null, receiver_id: "vault.morrow.testnet", method_names: [] },
    },
  },
};
const rpc = (keys: unknown[]) => ({ jsonrpc: "2.0", id: "morrow-web", result: { keys } });

describe("parseConfig", () => {
  it("maps /config.json and derives the co-signer from the NEAR network", () => {
    expect(parseConfig(CONFIG)).toEqual({
      network: { btc: "signet", near: "testnet" },
      contractId: "vault.morrow.testnet",
      nearRpcUrl: "https://rpc.testnet.near.org",
      btcBackendUrl: "https://mempool.space/signet/api",
      watcherUrl: "https://watcher.example.org",
      coSigner: "v1.signer-prod.testnet",
    });
    expect(parseConfig({ ...CONFIG, near_network: "mainnet" })?.coSigner).toBe("v1.signer");
    expect(parseConfig({ ...CONFIG, near_network: "mock", near_rpc_url: null })?.coSigner).toBe(
      "mock-signer",
    );
    expect(parseConfig({ ...CONFIG, watcher_url: null })?.watcherUrl).toBeNull();
  });

  it.each([
    null,
    [],
    "config",
    { ...CONFIG, near_network: "betanet" },
    { ...CONFIG, btc_network: "mainnet" },
    { ...CONFIG, vault_contract: "" },
    { ...CONFIG, btc_backend_url: null },
    { ...CONFIG, near_rpc_url: "not a url" },
    { ...CONFIG, watcher_url: 7 },
  ])("rejects %j", (body) => {
    expect(parseConfig(body)).toBeNull();
  });
});

describe("contractStateFrom", () => {
  it("is locked with no keys or only function-call keys", () => {
    expect(contractStateFrom(rpc([]))).toBe("locked");
    expect(contractStateFrom(rpc([functionCall]))).toBe("locked");
  });

  it("is unlocked with any full-access key", () => {
    expect(contractStateFrom(rpc([functionCall, fullAccess]))).toBe("unlocked");
  });

  it.each([
    null,
    { jsonrpc: "2.0", id: "morrow-web", error: { name: "HANDLER_ERROR" } },
    { result: {} },
    { result: { keys: "none" } },
    rpc([{ public_key: "ed25519:c", access_key: { permission: "Something" } }]),
    rpc([null]),
  ])("is unknown for %j", (response) => {
    expect(contractStateFrom(response)).toBe("unknown");
  });
});

describe("heartbeatFrom", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const beat = (updated_at: string | null) => ({
    last_seq: "41",
    last_block_timestamp: "1762084800000000000",
    updated_at,
  });

  it("reports whole minutes since the last heartbeat", () => {
    expect(heartbeatFrom(beat("2026-11-02T11:59:00Z"), now)).toEqual({
      kind: "seen",
      minutes: 1,
      stale: false,
    });
    expect(heartbeatFrom(beat("2026-11-02T11:59:31Z"), now)).toMatchObject({ minutes: 0 });
    // A watcher clock ahead of ours is not a negative age.
    expect(heartbeatFrom(beat("2026-11-02T12:00:20Z"), now)).toMatchObject({ minutes: 0 });
  });

  it("turns stale after 5 minutes without a heartbeat", () => {
    expect(heartbeatFrom(beat("2026-11-02T11:55:00Z"), now)).toMatchObject({ stale: false });
    expect(heartbeatFrom(beat("2026-11-02T11:54:59Z"), now)).toMatchObject({
      minutes: 5,
      stale: true,
    });
    expect(heartbeatFrom(beat("2026-11-02T11:54:00Z"), now)).toEqual({
      kind: "seen",
      minutes: 6,
      stale: true,
    });
  });

  it("is silent before the watcher has recorded progress", () => {
    expect(heartbeatFrom(beat(null), now)).toEqual({ kind: "silent" });
  });

  it.each([
    null,
    {},
    { error: "unavailable" },
    beat("yesterday"),
    { ...beat(null), updated_at: 7 },
  ])("is unreachable for %j", (body) => {
    expect(heartbeatFrom(body, now)).toEqual({ kind: "unreachable" });
  });
});

describe("heartbeatUrl", () => {
  it("appends /heartbeat to the base, keeping its path", () => {
    expect(heartbeatUrl("https://watcher.example.org")).toBe(
      "https://watcher.example.org/heartbeat",
    );
    expect(heartbeatUrl("https://example.org/watcher/")).toBe(
      "https://example.org/watcher/heartbeat",
    );
  });
});

describe("withTimeout", () => {
  it("aborts after the timeout", () => {
    vi.useFakeTimers();
    try {
      const signal = withTimeout(new AbortController().signal, 1_000);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows the caller's signal, including one already aborted", () => {
    const caller = new AbortController();
    const signal = withTimeout(caller.signal, 60_000);
    caller.abort();
    expect(signal.aborted).toBe(true);
    const done = new AbortController();
    done.abort();
    expect(withTimeout(done.signal).aborted).toBe(true);
  });
});
