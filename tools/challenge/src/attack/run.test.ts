import { parseNearKey, type Utxo } from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import { dryRunPorts, FakeBitcoin, DRY_RUN_FUNCTION_CALL_KEY } from "./dry-run.js";
import { WITNESS_TEMPLATES } from "@morrow/core-ts";
import type { CallResult, NearPort } from "./near.js";
import type { PublicRound } from "../store.js";
import {
  AttackRun,
  runAttack,
  type AttackParams,
  type AttackPorts,
  type BitcoinPort,
  type Clock,
  type LogEntryView,
  type RoundSource,
  type Watcher,
} from "./run.js";

const DRY: AttackParams = {
  seed: 7,
  n: 100,
  rounds: 3,
  network: "mock",
  nearNetwork: "testnet",
  dryRun: true,
  toolCommit: null,
};

describe("dry run (round script, all categories)", () => {
  it("exits 0, is mock, 100 attempts over ≤3 rounds, 0 sats, every on-chain attempt logged", async () => {
    const ports = await dryRunPorts();
    const { report, exitCode } = await runAttack(ports, DRY);
    expect(exitCode).toBe(0);
    expect(report.header.network).toBe("mock");
    expect(report.attempts).toHaveLength(100);
    expect(report.rounds.length).toBeLessThanOrEqual(3);
    expect(report.summary.sats_to_attackers).toBe(0);
    expect(report.summary.on_log_matched).toBe(report.summary.on_log_total);
    expect(report.summary.missing_hashes).toEqual([]);
    expect(report.summary.passed).toBe(true);
    const cats = new Set(report.attempts.map((a) => a.category));
    for (const c of [
      "withdrawal_request",
      "spend_allowance",
      "refresh",
      "policy_change",
      "early_execute",
    ] as const) {
      expect(cats.has(c)).toBe(true);
    }
    // The round script: an ERR_UNAUTHORIZED clawback, a bad envelope, an accepted request.
    const codes = report.attempts.map((a) => a.actual);
    expect(codes).toContain("ERR_UNAUTHORIZED");
    expect(codes).toContain("ERR_BAD_ENVELOPE");
    expect(report.attempts.some((a) => a.actual_class === "accepted")).toBe(true);
  });

  it("is deterministic for a seed", async () => {
    const a = await new AttackRun(await dryRunPorts(), DRY).execute();
    const b = await new AttackRun(await dryRunPorts(), DRY).execute();
    expect(a.attempts.map((x) => [x.category, x.actual])).toEqual(
      b.attempts.map((x) => [x.category, x.actual]),
    );
  });

  it("short run: --n 12 --rounds 1", async () => {
    const { report, exitCode } = await runAttack(await dryRunPorts(), { ...DRY, n: 12, rounds: 1 });
    expect(exitCode).toBe(0);
    expect(report.attempts).toHaveLength(12);
    expect(report.rounds).toHaveLength(1);
  });
});

describe("failures (exit 1)", () => {
  it("an unexpected success fails the run", async () => {
    const ports = await dryRunPorts();
    const inner = ports.near.call;
    // The Owner's own begin_clawback (expected ERR_UNAUTHORIZED) is wrongly accepted.
    ports.near = {
      ...ports.near,
      call: async (key, plan) =>
        plan.method === "begin_clawback"
          ? ({ kind: "accepted", hash: "f".repeat(64), value: "9", logs: [] } as CallResult)
          : inner(key, plan),
    };
    const { report, exitCode } = await runAttack(ports, { ...DRY, n: 12, rounds: 1 });
    expect(exitCode).toBe(1);
    expect(report.summary.passed).toBe(false);
    const claw = report.attempts.find((a) => a.category === "clawback");
    expect(claw?.expected_match).toBe(false);
  });

  it("sats at an attacker address fail the run", async () => {
    const ports = await dryRunPorts();
    const base = ports.bitcoin;
    const vaultCoin: Utxo = { txid: "ab".repeat(32), vout: 0, value_sats: "100000", height: 190 };
    ports.bitcoin = {
      getTipHeight: () => base.getTipHeight(),
      broadcast: (hex) => base.broadcast(hex),
      // Vault addresses (tb1q…q…) keep their funded coin; any other address holds 500 sats.
      getUtxos: async (address) => {
        const real = await base.getUtxos(address);
        if (real.length > 0) return real;
        return address.startsWith("tb1q")
          ? [{ txid: "cd".repeat(32), vout: 0, value_sats: "500", height: 200 }]
          : [vaultCoin];
      },
    };
    const { report, exitCode } = await runAttack(ports, { ...DRY, n: 12, rounds: 1 });
    expect(exitCode).toBe(1);
    expect(report.summary.sats_to_attackers).toBeGreaterThan(0);
    expect(report.summary.passed).toBe(false);
  });

  it("a hash missing from the Attempt Log fails the run", async () => {
    const ports = await dryRunPorts();
    ports.feed = { entries: async () => [] };
    const { report, exitCode } = await runAttack(ports, {
      ...DRY,
      n: 12,
      rounds: 1,
      logWaitMs: 1,
    });
    expect(exitCode).toBe(1);
    expect(report.summary.on_log_matched).toBe(0);
    expect(report.summary.missing_hashes.length).toBeGreaterThan(0);
  });
});

describe("pre-inclusion refusal and allowance stop", () => {
  it("stops cleanly when the key is below 0.05 NEAR, with a stopped_reason", async () => {
    const ports = await dryRunPorts();
    ports.near = {
      ...ports.near,
      accessKey: async () => ({ exists: true, nonce: 1, allowanceYocto: 1n }),
    };
    const { report } = await runAttack(ports, { ...DRY, n: 12, rounds: 1 });
    expect(report.summary.stopped_reason).toMatch(/0\.05 NEAR/);
    // Only Bitcoin spends (which do not need the key's allowance) may have run.
    expect(report.attempts.every((a) => a.method === null)).toBe(true);
  });
});

// Hand-built ports for the scenarios the mock cannot produce.

const KEY = DRY_RUN_FUNCTION_CALL_KEY;
const ALT_KEY =
  "ed25519:66m7p6tWp1rAfxZSpZsSKMee8gQwbaUHo94TFer32vkovBffNHHtMeZKVMGqj4Gz533H6qt6QhdUPLBWp8MEp13k";

class StepClock implements Clock {
  private t = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

function roundFor(key: string): PublicRound {
  return {
    round: 1,
    vault_contract: "vault.challenge",
    near_network: "testnet",
    btc_network: "signet",
    vault_id: "1",
    owner_account: "r1.challenge",
    owner_key: `02${"11".repeat(32)}`,
    owner_key_secret: "11".repeat(32),
    near_function_call_key: key,
    vault_address: "tb1qvault",
    escape_timelock_blocks: 26_280,
    funding_txid: "ab".repeat(32),
    funding_height: 190,
    rotation_deadline_height: 21_214,
  };
}

function minimalNear(overrides: Partial<NearPort> = {}): NearPort {
  const vault = {
    vault_id: "1",
    owner_account: "r1.challenge",
    owner_key: `02${"11".repeat(32)}`,
    state: "active" as const,
    cosigner_pubkeys: { vault: `02${"aa".repeat(32)}`, allowance: `03${"bb".repeat(32)}` },
    addresses: { vault: "tb1qvault", allowance: "tb1qallow" },
    storage_balance: "0",
    created_at: "0",
    pending_change: null,
    policy: {} as never,
  };
  return {
    accessKey: async () => ({ exists: true, nonce: 1, allowanceYocto: null }),
    getVault: async () => vault as never,
    getVaultKit: async () =>
      ({
        kit_version: 1,
        btc_network: "signet",
        vault_script_hex: "mock-",
        allowance_script_hex: "mock-",
        addresses: { vault: "tb1qvault", allowance: "tb1qallow" },
        escape_timelock_blocks: 26_280,
        cosigner_pubkeys: { vault: `02${"aa".repeat(32)}`, allowance: `03${"bb".repeat(32)}` },
        witness_templates: WITNESS_TEMPLATES,
      }) as never,
    codeHash: async () => "codehash",
    tipHeight: async () => 1,
    call: async () => ({
      kind: "refused",
      hash: "1".repeat(64),
      code: "ERR_CLAWED_BACK",
      failure: "x",
    }),
    ...overrides,
  };
}

function emptyBitcoin(): BitcoinPort {
  return {
    getUtxos: async () => [] as Utxo[],
    getTipHeight: async () => 1,
    broadcast: async () => "txid",
  };
}

describe("next round wait", () => {
  it("waits through a 404 then continues with the round", async () => {
    let served = 0;
    const rounds: RoundSource = {
      current: async () => (served++ === 0 ? null : roundFor(KEY)),
    };
    const watcher: Watcher = { tick: async () => null };
    const feed = { entries: async () => [] as LogEntryView[] };
    const ports: AttackPorts = {
      rounds,
      near: minimalNear(),
      bitcoin: emptyBitcoin(),
      feed,
      watcher,
      clock: new StepClock(),
    };
    const report = await new AttackRun(ports, {
      ...DRY,
      n: 4,
      rounds: 1,
      roundWaitMs: 10 * 60_000,
    }).execute();
    // It did not stop for lack of a round; attempts ran.
    expect(report.summary.stopped_reason).toBeNull();
    expect(report.attempts.length).toBeGreaterThan(0);
  });

  it("stops with a reason when no round confirms within the wait", async () => {
    const ports: AttackPorts = {
      rounds: { current: async () => null },
      near: minimalNear(),
      bitcoin: emptyBitcoin(),
      feed: { entries: async () => [] },
      watcher: { tick: async () => null },
      clock: new StepClock(),
    };
    const report = await new AttackRun(ports, {
      ...DRY,
      n: 4,
      rounds: 1,
      roundWaitMs: 1,
    }).execute();
    expect(report.summary.stopped_reason).toMatch(/no confirmed round/);
  });
});

describe("key rotation mid-run", () => {
  it("picks up a new key from /round and records both public keys", async () => {
    let rotated = false;
    const rounds: RoundSource = {
      current: async () => roundFor(rotated ? ALT_KEY : KEY),
    };
    const near = minimalNear({
      accessKey: async (_a, publicKey) => {
        const altPub = parseNearKey(ALT_KEY).publicKeyString;
        if (publicKey === altPub) return { exists: true, nonce: 1, allowanceYocto: null };
        // The first key is spent; asking /round yields the rotated one.
        rotated = true;
        return { exists: true, nonce: 1, allowanceYocto: 1n };
      },
    });
    const ports: AttackPorts = {
      rounds,
      near,
      bitcoin: emptyBitcoin(),
      feed: { entries: async () => [] },
      watcher: { tick: async () => null },
      clock: new StepClock(),
    };
    const report = await new AttackRun(ports, { ...DRY, n: 6, rounds: 1 }).execute();
    expect(report.header.public_keys).toContain(parseNearKey(KEY).publicKeyString);
    expect(report.header.public_keys).toContain(parseNearKey(ALT_KEY).publicKeyString);
    expect(report.summary.stopped_reason).toBeNull();
  });
});

describe("Bitcoin owner-only broadcast", () => {
  const kit = {
    kit_version: 1 as const,
    btc_network: "signet" as const,
    vault_script_hex: "aa".repeat(40), // not a mock kit: the run will build and broadcast
    allowance_script_hex: "aa".repeat(40),
    addresses: { vault: "tb1qvault", allowance: "tb1qallow" },
    escape_timelock_blocks: 26_280,
    cosigner_pubkeys: { vault: `02${"aa".repeat(32)}`, allowance: `03${"bb".repeat(32)}` },
    witness_templates: WITNESS_TEMPLATES,
  };
  const vaultCoin: Utxo = { txid: "ab".repeat(32), vout: 0, value_sats: "1000000", height: 190 };

  function ports(broadcast: BitcoinPort["broadcast"]): AttackPorts {
    return {
      rounds: { current: async () => roundFor(KEY) },
      near: minimalNear({ getVaultKit: async () => kit as never }),
      bitcoin: {
        getUtxos: async (address) => (address === "tb1qvault" ? [vaultCoin] : []),
        getTipHeight: async () => 1,
        broadcast,
      },
      feed: { entries: async () => [] },
      watcher: { tick: async () => null },
      clock: new StepClock(),
    };
  }

  it("records a rejected broadcast as off_log with the rejection text", async () => {
    const report = await new AttackRun(
      ports(async () => {
        throw new Error("non-BIP68-final");
      }),
      { ...DRY, n: 5, rounds: 1 },
    ).execute();
    const bitcoin = report.attempts.filter((a) => a.method === null);
    expect(bitcoin.length).toBeGreaterThan(0);
    expect(bitcoin.every((a) => a.actual_class === "off_log")).toBe(true);
    expect(bitcoin.every((a) => a.expected_match)).toBe(true);
    const evidence = bitcoin[0]?.off_log;
    expect(evidence?.kind).toBe("bitcoin");
    if (evidence?.kind === "bitcoin") expect(evidence.rejection).toMatch(/non-BIP68-final/);
  });

  it("fails the run when the node accepts the broadcast", async () => {
    const report = await new AttackRun(
      ports(async () => "accepted-txid"),
      { ...DRY, n: 5, rounds: 1 },
    ).execute();
    expect(report.summary.passed).toBe(false);
    const bitcoin = report.attempts.filter((a) => a.method === null);
    expect(bitcoin.some((a) => !a.expected_match)).toBe(true);
  });
});

describe("not deployed (live mix)", () => {
  it("lists refresh, spend_allowance, policy_change and sends none of them", async () => {
    const report = await new AttackRun(
      {
        rounds: { current: async () => roundFor(KEY) },
        near: minimalNear(),
        bitcoin: emptyBitcoin(),
        feed: { entries: async () => [] },
        watcher: { tick: async () => null },
        clock: new StepClock(),
      },
      { ...DRY, n: 20, rounds: 1, dryRun: false },
    ).execute();
    expect(report.summary.not_deployed).toEqual(["refresh", "spend_allowance", "policy_change"]);
    const methods = new Set(report.attempts.map((a) => a.method));
    expect(methods.has("refresh")).toBe(false);
    expect(methods.has("spend_allowance")).toBe(false);
    expect(methods.has("propose_policy_change")).toBe(false);
  });
});

describe("FakeBitcoin helper", () => {
  it("funds an address and reads it back", async () => {
    const b = new FakeBitcoin();
    b.fund("tb1qx", 100_000n);
    expect(await b.getUtxos("tb1qx")).toHaveLength(1);
    expect(await b.getUtxos("tb1qy")).toEqual([]);
  });
});
