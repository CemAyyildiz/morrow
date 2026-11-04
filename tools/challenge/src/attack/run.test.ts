import { createHash } from "node:crypto";
import {
  BitcoinBackendError,
  MorrowContractError,
  WITNESS_TEMPLATES,
  parseNearKey,
  type NearKey,
  type Utxo,
} from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import type { PolicyChangeOutcome } from "../attempts.js";
import type { PublicRound } from "../store.js";
import { DRY_RUN_FUNCTION_CALL_KEY, FakeBitcoin, dryRunPorts } from "./dry-run.js";
import type { CallPlan, CallResult, NearPort } from "./near.js";
import {
  AttackRun,
  DECOY_COIN,
  canonicalJson,
  runAttack,
  type AttackParams,
  type AttackPorts,
  type BitcoinPort,
  type Clock,
  type LogEntryView,
} from "./run.js";

const DRY: AttackParams = {
  seed: 7,
  n: 100,
  rounds: 3,
  nearNetwork: "testnet",
  dryRun: true,
  toolCommit: null,
};
const SHORT: AttackParams = { ...DRY, n: 13, rounds: 1, logWaitMs: 1, clawbackWaitMs: 1 };
const KEY = DRY_RUN_FUNCTION_CALL_KEY;
const ALT_KEY =
  "ed25519:GHMRn2eeRLkLSi4WEBqPhZ3FruDBxBiiRkS1Tnch12BiQ2LeVe6kW6diDdvLHwEtmZMnwSSCdVAUD1PALV8MrPi";
const ACTIONS = [
  "withdrawal_request",
  "spend_allowance",
  "refresh",
  "policy_change",
  "early_execute",
] as const;

/** Wraps the dry-run `call` so one method answers as `answer` decides (undefined: unchanged). */
async function dryWith(
  answer: (plan: CallPlan, inner: () => Promise<CallResult>) => Promise<CallResult> | undefined,
) {
  const ports = await dryRunPorts();
  const call = ports.near.call;
  const batch = ports.near.callBatch;
  const wrapped = (key: NearKey, plan: CallPlan) =>
    answer(plan, () => call(key, plan)) ?? call(key, plan);
  ports.near = {
    ...ports.near,
    call: wrapped,
    callBatch: (key, plans) =>
      plans.some((p) => answer(p, () => Promise.reject(new Error("probe"))) !== undefined)
        ? Promise.all(plans.map((p) => wrapped(key, p)))
        : batch(key, plans),
  };
  return ports;
}

describe("dry run", () => {
  it("--n 100 --seed 7: exit 0, mock, 100 attempts over ≤3 rounds, all five actions, 0 sats, all logged", async () => {
    const { report, exitCode } = await runAttack(await dryRunPorts(), DRY);
    expect(exitCode).toBe(0);
    expect(report.header.network).toBe("mock");
    expect(report.attempts).toHaveLength(100);
    expect(report.rounds.length).toBeLessThanOrEqual(3);
    expect(report.summary.sats_to_attackers).toBe(0);
    expect(report.summary.on_log_matched).toBe(report.summary.on_log_total);
    expect(report.summary.missing_hashes).toEqual([]);
    expect(report.rounds.every((r) => r.clawback_seen === true && r.clawback_op_id)).toBe(true);
    const cats = new Set(report.attempts.map((a) => a.category));
    for (const c of ACTIONS) expect(cats.has(c)).toBe(true);
  });

  it("refuses refresh, policy_change and spend_allowance by Policy on the active Vault", async () => {
    const { report } = await runAttack(await dryRunPorts(), SHORT);
    const pre = report.attempts.slice(0, 5).map((a) => [a.category, a.actual]);
    expect(pre).toEqual([
      ["clawback", "ERR_UNAUTHORIZED"],
      ["withdrawal_request", "ERR_BAD_ENVELOPE"],
      ["spend_allowance", "ERR_ALLOWANCE_LIMIT"],
      ["refresh", "ERR_FEE_TOO_HIGH"],
      ["policy_change", "ERR_SCRIPT_BOUND"],
    ]);
  });

  it("is reproducible for a seed: same attempts, same attacker addresses", async () => {
    const a = await new AttackRun(await dryRunPorts(), DRY).execute();
    const b = await new AttackRun(await dryRunPorts(), DRY).execute();
    expect(a.attempts.map((x) => [x.category, x.actual])).toEqual(
      b.attempts.map((x) => [x.category, x.actual]),
    );
    expect(a.summary.attacker_addresses).toEqual(b.summary.attacker_addresses);
    // Envelopes are sealed from the seed too, so even the args hash the same.
    expect(a.attempts.map((x) => x.args_sha256)).toEqual(b.attempts.map((x) => x.args_sha256));
  });

  it("stores each call's args and hashes them canonically", async () => {
    const { report } = await runAttack(await dryRunPorts(), SHORT);
    const call = report.attempts.find((a) => a.method === "request_withdrawal")!;
    expect(call.args).toMatchObject({ vault_id: "1" });
    expect(call.args_sha256).toBe(
      createHash("sha256").update(canonicalJson(call.args)).digest("hex"),
    );
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}');
  });

  it("sends the window attempts at once and records which outcome each met", async () => {
    const ports = await dryRunPorts();
    const batches: string[][] = [];
    const batch = ports.near.callBatch;
    ports.near = {
      ...ports.near,
      callBatch: (key, plans) => {
        batches.push(plans.map((p) => p.method));
        return batch(key, plans);
      },
    };
    const { report } = await runAttack(ports, SHORT);
    expect(batches).toEqual([
      ["apply_policy_change"],
      ["begin_execute", "sign_input", "request_withdrawal"],
    ]);
    const window = report.attempts.filter((a) => a.window_result !== null);
    expect(window.map((a) => [a.actual, a.window_result])).toEqual([
      ["ERR_CHANGE_NOT_EFFECTIVE", "own_code"],
      ["ERR_NOT_EXECUTABLE", "own_code"],
      ["ERR_BAD_OP_STATE", "own_code"],
      ["ERR_OUTPOINT_RESERVED", "own_code"],
    ]);
  });
});

describe("Recovery Address redirect (TH-12)", () => {
  const isRedirect = (a: { method: string | null; args: unknown }) =>
    a.method === "propose_policy_change" &&
    Object.hasOwn((a.args as { changes: object }).changes, "recovery_address");
  const redirectTo = (a: { args: unknown }) =>
    (a.args as { changes: { recovery_address: string } }).changes.recovery_address;

  /** Dry-run ports whose feed rewrites Policy Change entries. */
  async function dryFeed(map: (v: LogEntryView) => LogEntryView) {
    const ports = await dryRunPorts();
    const inner = ports.feed;
    ports.feed = {
      entries: async () =>
        (await inner.entries()).map((v) => (v.type === "policy_change" ? map(v) : v)),
    };
    return ports;
  }

  it("is accepted, raced by an apply, then vetoed by the watcher before the round goes on", async () => {
    const ports = await dryRunPorts();
    const { report, exitCode } = await runAttack(ports, DRY);
    expect(exitCode).toBe(0);
    const redirects = report.attempts.filter(isRedirect);
    expect(redirects).toHaveLength(report.rounds.length);
    for (const attempt of redirects) {
      expect([attempt.actual, attempt.expected_match]).toEqual(["accepted", true]);
      expect(attempt.log_entry).not.toBeNull();
      expect(attempt.op_id).toBeNull();
      expect(report.summary.attacker_addresses.map((a) => a.address)).toContain(
        redirectTo(attempt),
      );
      const round = report.rounds.find((r) => r.round === attempt.round)!;
      expect(round.policy_change_id).toBe(attempt.change_id);
      expect(round.policy_change_outcome).toBe("vetoed");
      // The very next attempt tries to apply it, and the contract refuses.
      const apply = report.attempts.find((a) => a.id === attempt.id + 1)!;
      expect(apply.method).toBe("apply_policy_change");
      expect(apply.args).toEqual({ change_id: attempt.change_id });
      expect([apply.actual, apply.expected_match]).toEqual(["ERR_CHANGE_NOT_EFFECTIVE", true]);
      expect(apply.window_result).toBe("own_code");
    }
    expect(report.summary.veto_missing).toEqual([]);
    expect(report.summary.redirects_vetoed).toBe(report.rounds.length);
    const vault = await ports.chain.mock.getVault("1");
    expect(vault.pending_change).toBeNull();
    expect(vault.policy.recovery_address).not.toBe(redirectTo(redirects[0]!));
  });

  it("a change still pending at the wait's end fails the run", async () => {
    const ports = await dryRunPorts();
    const inner = ports.watcher;
    // A watcher that claws back but never vetoes.
    ports.watcher = {
      tick: async (vaultId) => {
        const vault = await ports.chain.mock.getVault(vaultId);
        return vault.pending_change ? null : inner.tick(vaultId);
      },
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("pending");
    expect(report.summary.veto_missing).toEqual([1]);
    expect(report.summary.redirects_vetoed).toBe(0);
  });

  it("an applied redirect fails the run", async () => {
    const ports = await dryRunPorts();
    const getVault = ports.near.getVault;
    let to: string | null = null;
    const call = ports.near.call;
    ports.near = {
      ...ports.near,
      call: async (key, plan) => {
        const result = await call(key, plan);
        const changes = (plan.args as { changes?: { recovery_address?: string } }).changes;
        if (changes?.recovery_address) to = changes.recovery_address;
        return result;
      },
      getVault: async (id) => {
        const vault = await getVault(id);
        return to ? { ...vault, policy: { ...vault.policy, recovery_address: to } } : vault;
      },
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("applied");
    expect(report.summary.veto_missing).toEqual([1]);
  });

  it("no longer pending but never settled in the feed: unread, and the run fails", async () => {
    const ports = await dryFeed((v) => ({ ...v, outcome: "pending" }));
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("unread");
    expect(report.summary.veto_missing).toEqual([1]);
  });

  it("a Vault that cannot be read during the wait: unreadable, and the run fails", async () => {
    const ports = await dryRunPorts();
    const getVault = ports.near.getVault;
    let proposed = false;
    const call = ports.near.call;
    ports.near = {
      ...ports.near,
      call: async (key, plan) => {
        if (isRedirect(plan)) proposed = true;
        return call(key, plan);
      },
      getVault: async (id) => {
        if (proposed) throw new Error("RPC down");
        return getVault(id);
      },
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("unreadable");
    expect(report.summary.veto_missing).toEqual([1]);
  });

  it("accepted with no readable change id: unreadable, and the run fails", async () => {
    const ports = await dryWith((plan, inner) =>
      isRedirect(plan) ? inner().then((r) => ({ ...r, value: null }) as CallResult) : undefined,
    );
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_id).toBeNull();
    expect(report.rounds[0]?.policy_change_outcome).toBe("unreadable");
    expect(report.attempts.some((a) => a.method === "apply_policy_change")).toBe(false);
  });

  it("an unreadable redirect the log shows accepted takes its change id and outcome from the log", async () => {
    const ports = await dryWith((plan, inner) =>
      isRedirect(plan)
        ? inner().then((r) => ({ kind: "unreadable", hash: r.hash, error: "timeout after send" }))
        : undefined,
    );
    const { report } = await runAttack(ports, SHORT);
    const redirect = report.attempts.find(isRedirect)!;
    expect(redirect.actual).toBe("accepted");
    expect(redirect.change_id).toBe("1");
    // The veto was never awaited in the round; the log shows the watcher's later veto.
    expect(report.rounds[0]?.policy_change_id).toBe("1");
    expect(report.rounds[0]?.policy_change_outcome).toBe("vetoed");
  });

  it("an unreadable redirect the log shows still pending fails the run", async () => {
    const ports = await dryWith((plan, inner) =>
      isRedirect(plan)
        ? inner().then((r) => ({ kind: "unreadable", hash: r.hash, error: "timeout after send" }))
        : undefined,
    );
    const inner = ports.feed;
    ports.feed = {
      entries: async () =>
        (await inner.entries()).map((v) =>
          v.type === "policy_change" ? { ...v, outcome: "pending" } : v,
        ),
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("pending");
    expect(report.summary.veto_missing).toEqual([1]);
  });

  it("withdrawn neither proves the veto nor fails the round", async () => {
    const ports = await dryFeed((v) => (v.change_id === "1" ? { ...v, outcome: "withdrawn" } : v));
    const { report, exitCode } = await runAttack(ports, DRY);
    expect(report.rounds[0]?.policy_change_outcome).toBe("withdrawn");
    expect(report.summary.veto_missing).toEqual([]);
    expect(report.summary.redirects_vetoed).toBe(report.rounds.length - 1);
    expect(exitCode).toBe(0);

    // With no vetoed redirect at all the run cannot pass.
    const only = await runAttack(await dryFeed((v) => ({ ...v, outcome: "withdrawn" })), SHORT);
    expect(only.report.summary.veto_missing).toEqual([]);
    expect(only.report.summary.redirects_vetoed).toBe(0);
    expect(only.exitCode).toBe(1);
  });

  it("a run with no accepted redirect does not pass", async () => {
    const ports = await dryRunPorts();
    const propose = ports.chain.mock.proposePolicyChange.bind(ports.chain.mock);
    // Another visitor's change is always pending: every redirect is refused.
    ports.chain.mock.proposePolicyChange = async (args) => {
      if (Object.hasOwn(args.changes, "recovery_address")) {
        throw new MorrowContractError("ERR_CHANGE_PENDING");
      }
      return propose(args);
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(report.attempts.find(isRedirect)?.actual).toBe("ERR_CHANGE_PENDING");
    expect(report.attempts.find(isRedirect)?.expected_match).toBe(true);
    expect(report.summary.missing_hashes).toEqual([]);
    expect(report.summary.veto_missing).toEqual([]);
    expect(report.summary.redirects_vetoed).toBe(0);
    expect(exitCode).toBe(1);
  });

  it("matches a Policy Change by change id + Vault id when the feed has no tx hash yet", async () => {
    const ports = await dryFeed((v) => ({ ...v, tx_hash: null }));
    const { report, exitCode } = await runAttack(ports, SHORT);
    const redirect = report.attempts.find(isRedirect)!;
    expect(redirect.log_entry).not.toBeNull();
    expect(report.summary.missing_hashes).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("a dry-run veto that throws does not stop the Clawback", async () => {
    const ports = await dryRunPorts();
    ports.chain.mock.vetoPolicyChange = async () => {
      throw new Error("veto failed");
    };
    const { report } = await runAttack(ports, SHORT);
    expect(report.rounds[0]?.clawback_seen).toBe(true);
    expect(report.rounds[0]?.policy_change_outcome).toBe("pending");
  });

  it("live: reads the veto from the feed once the change is no longer pending", async () => {
    let feedReads = 0;
    const near = minimalNear({
      call: async (_key, plan): Promise<CallResult> =>
        isRedirect(plan)
          ? { kind: "accepted", hash: "5".repeat(64), value: "4", logs: [] }
          : { kind: "refused", hash: "1".repeat(64), code: "ERR_CLAWED_BACK", failure: "x" },
    });
    const entry = (outcome: PolicyChangeOutcome): LogEntryView => ({
      n: 1,
      type: "policy_change",
      tx_hash: "5".repeat(64),
      op_id: null,
      change_id: "4",
      vault_id: "1",
      code: null,
      clawback_op_id: null,
      clawback_txid: null,
      clawback_broadcast: null,
      outcome,
    });
    const report = await new AttackRun(
      handPorts({
        near,
        // The feed lags: it still shows the change pending on the first read.
        feed: { entries: async () => [entry(feedReads++ === 0 ? "pending" : "vetoed")] },
      }),
      { ...HAND, n: 6, dryRun: false },
    ).execute();
    const redirect = report.attempts.find(isRedirect)!;
    expect(redirect.actual).toBe("accepted");
    expect(redirect.log_entry).toBe(1);
    expect(report.rounds[0]?.policy_change_outcome).toBe("vetoed");
    expect(report.summary.veto_missing).toEqual([]);
    expect(report.summary.redirects_vetoed).toBe(1);
  });
});

describe("failures (exit 1)", () => {
  it("an unexpected success is marked and fails the run", async () => {
    const ports = await dryWith((plan) =>
      plan.method === "begin_clawback"
        ? Promise.resolve({ kind: "accepted", hash: "f".repeat(64), value: "9", logs: [] })
        : undefined,
    );
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    const claw = report.attempts.find((a) => a.category === "clawback")!;
    expect(claw.unexpected).toBe(true);
    expect(report.summary.unexpected).toContain(claw.id);
  });

  it("ERR_CLAWED_BACK is not accepted for a pre-phase refusal", async () => {
    const ports = await dryWith((plan) =>
      plan.method === "begin_clawback"
        ? Promise.resolve({
            kind: "refused",
            hash: "e".repeat(64),
            code: "ERR_CLAWED_BACK",
            failure: "x",
          })
        : undefined,
    );
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.attempts.find((a) => a.category === "clawback")?.expected_match).toBe(false);
  });

  it("sats at an attacker address fail the run", async () => {
    const ports = await dryRunPorts();
    const base = ports.bitcoin;
    ports.bitcoin = {
      ...base,
      getTipHeight: () => base.getTipHeight(),
      broadcast: (hex) => base.broadcast(hex),
      getUtxos: async (address) => {
        const real = await base.getUtxos(address);
        return real.length > 0
          ? real
          : [{ txid: "cd".repeat(32), vout: 0, value_sats: "500", height: 200 }];
      },
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.summary.sats_to_attackers).toBeGreaterThan(0);
  });

  it("an unreadable attacker balance fails the run", async () => {
    const ports = await dryRunPorts();
    const base = ports.bitcoin;
    const vaults = new Set<string>();
    ports.bitcoin = {
      getTipHeight: () => base.getTipHeight(),
      broadcast: (hex) => base.broadcast(hex),
      getUtxos: async (address) => {
        const real = await base.getUtxos(address);
        if (real.length > 0 || vaults.has(address)) {
          vaults.add(address);
          return real;
        }
        throw new Error("backend down");
      },
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.summary.unreadable_balances.length).toBeGreaterThan(0);
  });

  it("a hash missing from the Attempt Log fails the run", async () => {
    const ports = await dryRunPorts();
    ports.feed = { entries: async () => [] };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.summary.missing_hashes.length).toBeGreaterThan(0);
  });

  it("matches op ids only against withdrawal entries, not a Policy Change's change id", async () => {
    const ports = await dryRunPorts();
    const inner = ports.feed;
    ports.feed = {
      entries: async () =>
        (await inner.entries()).map((v): LogEntryView =>
          v.type === "withdrawal" ? { ...v, type: "policy_change", tx_hash: null } : v,
        ),
    };
    const { report } = await runAttack(ports, SHORT);
    const request = report.attempts.find(
      (a) => a.category === "withdrawal_request" && a.actual_class === "accepted",
    )!;
    expect(request.log_entry).toBeNull();
    expect(report.summary.passed).toBe(false);
  });

  it("an unreadable call fails the run", async () => {
    const ports = await dryWith((plan) =>
      plan.method === "begin_clawback"
        ? Promise.resolve({ kind: "unreadable", hash: null, error: "socket hang up" })
        : undefined,
    );
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(exitCode).toBe(1);
    expect(report.summary.unreadable).toHaveLength(1);
  });

  it("an unreadable call found in the log takes the logged outcome", async () => {
    const ports = await dryWith((plan, inner) =>
      (plan.args as { envelope?: string }).envelope === "ab".repeat(79)
        ? inner().then((r) => ({ kind: "unreadable", hash: r.hash, error: "timeout after send" }))
        : undefined,
    );
    const { report, exitCode } = await runAttack(ports, SHORT);
    const bad = report.attempts.find((a) => a.category === "withdrawal_request")!;
    expect(bad.actual).toBe("ERR_BAD_ENVELOPE");
    expect(bad.log_entry).not.toBeNull();
    expect(exitCode).toBe(0);
  });

  it("no Clawback seen: the round is marked, its fill skipped, and the run fails", async () => {
    const ports = await dryRunPorts();
    ports.watcher = { tick: async () => null };
    const { report, exitCode } = await runAttack(ports, { ...SHORT, n: 14 });
    expect(exitCode).toBe(1);
    expect(report.rounds[0]?.clawback_seen).toBe(false);
    expect(report.summary.clawback_missing).toEqual([1]);
    expect(report.attempts.length).toBeLessThan(14); // no fill
  });
});

describe("pre-inclusion refusals and the allowance stop", () => {
  it("NotEnoughAllowance is off_log with the RPC error and stops the run", async () => {
    const ports = await dryWith((plan) =>
      (plan.args as { vault_id?: string }).vault_id === "2"
        ? Promise.resolve({
            kind: "not_included",
            hash: "d".repeat(64),
            reason: "allowance",
            error: "NotEnoughAllowance",
          })
        : undefined,
    );
    const { report, exitCode } = await runAttack(ports, { ...SHORT, n: 24, rounds: 2 });
    const off = report.attempts.find((a) => a.off_log?.kind === "pre_inclusion")!;
    expect(off.off_log).toMatchObject({ reason: "allowance", error: "NotEnoughAllowance" });
    expect(report.summary.stopped_reason).toMatch(/NotEnoughAllowance/);
    // A clean allowance stop after one whole round still passes.
    expect(exitCode).toBe(0);
  });

  it("an allowance stop before any whole round fails", async () => {
    const ports = await dryRunPorts();
    ports.near = {
      ...ports.near,
      accessKey: async () => ({ exists: true, nonce: 1, allowanceYocto: 1n }),
    };
    const { report, exitCode } = await runAttack(ports, SHORT);
    expect(report.summary.stopped_reason).toMatch(/0\.05 NEAR/);
    expect(exitCode).toBe(1);
  });
});

// Hand-built ports for what the mock cannot produce.

class StepClock implements Clock {
  private t = 0;
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

function roundFor(key: string, overrides: Partial<PublicRound> = {}): PublicRound {
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
    ...overrides,
  };
}

const KIT = {
  kit_version: 1 as const,
  btc_network: "signet" as const,
  vault_script_hex: "aa".repeat(40),
  allowance_script_hex: "aa".repeat(40),
  addresses: { vault: "tb1qvault", allowance: "tb1qallow" },
  escape_timelock_blocks: 26_280,
  cosigner_pubkeys: { vault: `02${"aa".repeat(32)}`, allowance: `03${"bb".repeat(32)}` },
  witness_templates: WITNESS_TEMPLATES,
};

function minimalNear(overrides: Partial<NearPort> = {}): NearPort {
  const vault = {
    vault_id: "1",
    owner_account: "r1.challenge",
    owner_key: `02${"11".repeat(32)}`,
    state: "active" as const,
    cosigner_pubkeys: KIT.cosigner_pubkeys,
    addresses: KIT.addresses,
    storage_balance: "0",
    created_at: "0",
    pending_change: null,
    policy: { watcher_x25519_pk: "44".repeat(32) } as never,
  };
  const call =
    overrides.call ??
    (async (): Promise<CallResult> => ({
      kind: "refused",
      hash: "1".repeat(64),
      code: "ERR_CLAWED_BACK",
      failure: "x",
    }));
  return {
    accessKey: async () => ({ exists: true, nonce: 1, allowanceYocto: null }),
    getVault: async () => vault as never,
    getVaultKit: async () => KIT as never,
    codeHash: async () => "codehash",
    tipHeight: async () => 1,
    call,
    callBatch: (key, plans) => Promise.all(plans.map((p) => call(key, p))),
    ...overrides,
  };
}

function handPorts(overrides: Partial<AttackPorts> = {}): AttackPorts {
  return {
    rounds: { current: async () => roundFor(KEY) },
    near: minimalNear(),
    bitcoin: { getUtxos: async () => [], getTipHeight: async () => 1, broadcast: async () => "x" },
    feed: { entries: async () => [] },
    watcher: { tick: async () => null },
    clock: new StepClock(),
    ...overrides,
  };
}
const HAND: AttackParams = { ...SHORT, n: 4 };

describe("rounds", () => {
  it("waits through a 404, then attacks the round", async () => {
    let served = 0;
    const report = await new AttackRun(
      handPorts({ rounds: { current: async () => (served++ === 0 ? null : roundFor(KEY)) } }),
      { ...HAND, roundWaitMs: 10 * 60_000 },
    ).execute();
    expect(report.header.challenge_rounds).toEqual([1]);
    expect(report.attempts.length).toBeGreaterThan(0);
  });

  it("stops with the last /round error and exits 1 when nothing was attacked", async () => {
    const ports = handPorts({
      rounds: {
        current: async () => {
          throw new Error("GET /round: HTTP 503 unavailable");
        },
      },
    });
    const { report, exitCode } = await runAttack(ports, { ...HAND, dryRun: false, roundWaitMs: 1 });
    expect(report.summary.stopped_reason).toMatch(/HTTP 503 unavailable/);
    expect(report.attempts).toHaveLength(0);
    expect(report.header.network).toBe("unknown");
    expect(exitCode).toBe(1);
  });

  it("never attacks the same round twice, and only an active Vault", async () => {
    const report = await new AttackRun(handPorts(), {
      ...HAND,
      n: 8,
      rounds: 2,
      roundWaitMs: 1,
    }).execute();
    expect(report.header.challenge_rounds).toEqual([1]);
    expect(report.summary.stopped_reason).toMatch(/already attacked/);

    const closed = await new AttackRun(
      handPorts({
        near: minimalNear({
          getVault: async () => ({ state: "clawed_back", policy: {} }) as never,
        }),
      }),
      { ...HAND, roundWaitMs: 1 },
    ).execute();
    expect(closed.summary.stopped_reason).toMatch(/Vault is clawed_back/);
  });

  it("stops on a round with unusable fields", async () => {
    const report = await new AttackRun(
      handPorts({ rounds: { current: async () => roundFor(KEY, { owner_key_secret: "xyz" }) } }),
      HAND,
    ).execute();
    expect(report.summary.stopped_reason).toMatch(/owner_key_secret/);
    expect(report.attempts).toHaveLength(0);
  });

  it("stops when /round is on another NEAR network", async () => {
    const report = await new AttackRun(
      handPorts({ rounds: { current: async () => roundFor(KEY, { near_network: "mainnet" }) } }),
      HAND,
    ).execute();
    expect(report.summary.stopped_reason).toMatch(/NEAR network mismatch/);
    expect(report.header.near_network).toBe("mainnet");
  });
});

describe("key rotation mid-run", () => {
  it("picks up the new key from /round, signs with it, and records both public keys", async () => {
    const oldPub = parseNearKey(KEY).publicKeyString;
    const newPub = parseNearKey(ALT_KEY).publicKeyString;
    let rotated = false;
    const signedWith: string[] = [];
    const near = minimalNear({
      accessKey: async (_a, publicKey) => {
        if (publicKey === oldPub) rotated = true; // spent: the operator publishes a new key
        return {
          exists: true,
          nonce: 1,
          allowanceYocto: publicKey === oldPub ? 1n : null,
        };
      },
      call: async (key) => {
        signedWith.push(key.publicKeyString);
        return { kind: "refused", hash: "1".repeat(64), code: "ERR_UNAUTHORIZED", failure: "x" };
      },
    });
    const report = await new AttackRun(
      handPorts({ near, rounds: { current: async () => roundFor(rotated ? ALT_KEY : KEY) } }),
      HAND,
    ).execute();
    expect(oldPub).not.toBe(newPub);
    expect(new Set(report.header.public_keys).size).toBe(2);
    expect(signedWith.length).toBeGreaterThan(0);
    expect(signedWith.every((k) => k === newPub)).toBe(true);
    expect(report.summary.stopped_reason).toBeNull();
  });
});

describe("Bitcoin Owner-Key-only spends", () => {
  const coin: Utxo = { txid: "ab".repeat(32), vout: 0, value_sats: "1000000", height: 190 };

  async function run(broadcast: BitcoinPort["broadcast"], extra: Partial<BitcoinPort> = {}) {
    const report = await new AttackRun(
      handPorts({
        bitcoin: {
          getUtxos: async (address) => (address === "tb1qvault" ? [coin] : []),
          getTipHeight: async () => 200,
          broadcast,
          ...extra,
        },
      }),
      { ...HAND, n: 9 },
    ).execute();
    const pick = (category: string) => report.attempts.find((a) => a.category === category)!;
    return { report, escape: pick("bitcoin_escape"), noCosigner: pick("bitcoin_no_cosigner") };
  }

  it("a node rejection for another reason is not the expected refusal", async () => {
    const { escape, noCosigner } = await run(async () => {
      throw new BitcoinBackendError(
        "/tx: HTTP 400 sendrawtransaction RPC error: insufficient fee",
        400,
      );
    });
    // The text fits neither path: both are rejections, but not the ones the spends test.
    expect(escape.actual).toBe("rejected:other_reason");
    expect(escape.expected_match).toBe(false);
    expect(noCosigner.expected_match).toBe(false);
  });

  it("matches non-BIP68-final for the Escape and a script failure for the no-co-signer spend", async () => {
    let n = 0;
    const { escape, noCosigner } = await run(async () => {
      n += 1;
      throw new BitcoinBackendError(
        n === 1
          ? "/tx: HTTP 400 non-BIP68-final"
          : "sendrawtransaction: mandatory-script-verify-flag-failed (Script evaluated without error but finished with a false/empty top stack element)",
        n === 1 ? 400 : 500,
      );
    });
    expect([escape.actual, escape.expected_match]).toEqual(["rejected", true]);
    expect([noCosigner.actual, noCosigner.expected_match]).toEqual(["rejected", true]);
    expect(escape.off_log).toMatchObject({
      kind: "bitcoin",
      rejection: expect.stringMatching(/BIP68/),
    });
    expect(escape.off_log?.kind === "bitcoin" && escape.off_log.raw_hex.length).toBeGreaterThan(0);
  });

  it("a backend that is down is unreadable, not a rejection", async () => {
    const { escape } = await run(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(escape.actual_class).toBe("unreadable");
  });

  it("an accepted broadcast is unexpected and fails the run", async () => {
    const { report, escape } = await run(async () => "txid");
    expect(escape.unexpected).toBe(true);
    expect(report.summary.passed).toBe(false);
  });

  it("never broadcasts the Escape once the coin has matured", async () => {
    const sent: string[] = [];
    const { escape } = await run(
      async (hex) => {
        sent.push(hex);
        throw new BitcoinBackendError("/tx: HTTP 400 mandatory-script-verify-flag-failed", 400);
      },
      { getTipHeight: async () => 190 + 26_280 },
    );
    expect([escape.actual_class, escape.note]).toEqual(["skipped", "coin matured"]);
    expect(sent).toHaveLength(1); // only the no-co-signer spend
  });

  it("a dust-sized coin cannot be built: unreadable with the reason", async () => {
    coin.value_sats = "600";
    try {
      const { escape } = await run(async () => "txid");
      expect(escape.actual_class).toBe("unreadable");
      expect(escape.note).toMatch(/dust/);
    } finally {
      coin.value_sats = "1000000";
    }
  });

  it("Vault coins that cannot be read make the spend unreadable", async () => {
    const { escape } = await run(async () => "txid", {
      getUtxos: async () => {
        throw new Error("backend down");
      },
    });
    expect(escape.actual_class).toBe("unreadable");
  });
});

describe("not deployed (live mix)", () => {
  it("lists nothing: Allowance spends (Story 5.2) and Policy Changes (Story 5.1) go out live", async () => {
    const report = await new AttackRun(handPorts(), {
      ...HAND,
      n: 20,
      dryRun: false,
    }).execute();
    expect(report.summary.not_deployed).toEqual([]);
    expect(report.summary.not_deployed_note).toBeNull();
    const methods = new Set(report.attempts.map((a) => a.method));
    expect(methods.has("spend_allowance")).toBe(true);
    expect(methods.has("propose_policy_change")).toBe(true);
  });

  it("sends the over-cap Refresh live (Story 4.1), on a decoy coin", async () => {
    const plans: CallPlan[] = [];
    const near = minimalNear({
      call: async (_key, plan): Promise<CallResult> => {
        plans.push(plan);
        const code = plan.method === "refresh" ? "ERR_FEE_TOO_HIGH" : "ERR_CLAWED_BACK";
        return { kind: "refused", hash: "1".repeat(64), code, failure: "x" };
      },
    });
    const report = await new AttackRun(handPorts({ near }), {
      ...HAND,
      n: 20,
      dryRun: false,
    }).execute();
    const refresh = report.attempts.find((a) => a.method === "refresh");
    expect(refresh?.category).toBe("refresh");
    expect(refresh?.expected).toEqual(["ERR_FEE_TOO_HIGH"]);
    expect(refresh?.actual).toBe("ERR_FEE_TOO_HIGH");
    expect(refresh?.unexpected).toBe(false);
    const sent = plans.find((p) => p.method === "refresh")?.args as { utxos: unknown[] };
    expect(sent.utxos).toEqual([DECOY_COIN]);
  });

  it("sends the after-Clawback Refresh on the round's real coins, expecting the closed Vault", async () => {
    const { report } = await runAttack(await dryRunPorts(), DRY);
    const fill = report.attempts.filter(
      (a) => a.method === "refresh" && !a.expected.includes("ERR_FEE_TOO_HIGH"),
    );
    expect(fill.length).toBeGreaterThan(0);
    for (const attempt of fill) {
      expect(attempt.expected).toEqual(["ERR_CLAWED_BACK", "ERR_VAULT_NOT_ACTIVE"]);
      expect(attempt.expected).toContain(attempt.actual);
      const round = report.rounds.find((r) => r.round === attempt.round);
      const utxos = (attempt.args as { utxos: { txid: string }[] }).utxos;
      expect(utxos).not.toContainEqual(DECOY_COIN);
      expect(utxos.map((u) => u.txid)).toEqual([round?.funding_txid]);
    }
  });
});

describe("FakeBitcoin", () => {
  it("funds an address and reads it back", async () => {
    const b = new FakeBitcoin();
    b.fund("tb1qx", 100_000n);
    expect(await b.getUtxos("tb1qx")).toHaveLength(1);
    expect(await b.getUtxos("tb1qy")).toEqual([]);
  });
});
