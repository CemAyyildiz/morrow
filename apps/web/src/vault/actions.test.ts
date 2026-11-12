import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleSpendHex,
  compressedPublicKey,
  txidOf,
  type Outpoint,
  type SpendOp,
  type Vault,
} from "@morrow/core-ts/browser";
import {
  actionGate,
  asSpendOp,
  asVault,
  broadcastTx,
  createdVaultId,
  isExecutableAt,
  maxWithdrawal,
  planClawback,
  planWithdrawal,
  runClawback,
  runExecute,
  runRequest,
  spendableCoins,
  waitForActive,
  type ActionDeps,
  type ActionStep,
  type GateInput,
} from "./actions";
import type { CallOutcome, ViewAnswer } from "./near";

const SIGNET = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
const WATCHER_PK = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";

const coin = (n: number, sats: number): Outpoint => ({
  txid: n.toString(16).padStart(2, "0").repeat(32),
  vout: n,
  value_sats: String(sats),
});

const vault = {
  vault_id: "12",
  policy: { btc_network: "signet", watcher_x25519_pk: WATCHER_PK },
} as unknown as Pick<Vault, "vault_id" | "policy">;

// A frozen op as the contract publishes it: one input, one P2WPKH output.
const UNSIGNED =
  "02000000" +
  "01" +
  `${"11".repeat(32)}00000000` +
  "00" +
  "fdffffff" +
  "01" +
  "1027000000000000" +
  `160014${"22".repeat(20)}` +
  "00000000";

afterEach(() => vi.unstubAllGlobals());

describe("planning", () => {
  it("spends the five largest confirmed coins", () => {
    const coins = [1, 2, 3, 4, 5, 6, 7].map((n) => coin(n, n * 1000));
    expect(spendableCoins(coins).map((c) => c.vout)).toEqual([7, 6, 5, 4, 3]);
  });

  it("leaves a fee bound under the most a request can ask for", () => {
    expect(maxWithdrawal([coin(1, 100_000)])).toBe(100_000n - 2n * 310n);
    expect(maxWithdrawal([coin(1, 500)])).toBe(0n);
  });

  it("plans a Withdrawal Request with a sealed envelope", () => {
    const plan = planWithdrawal(vault, [coin(1, 100_000)], ` ${SIGNET} `, "50000");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.args).toMatchObject({
      vault_id: "12",
      amount_sats: "50000",
      destination: SIGNET,
      fee_rate_sat_vb: 2,
      utxos: [coin(1, 100_000)],
    });
    expect(plan.args.envelope).toMatch(/^[0-9a-f]{160}$/);
  });

  it("says what is wrong with a request", () => {
    const coins = [coin(1, 100_000)];
    expect(planWithdrawal(vault, coins, "bc1qnope", "1000")).toEqual({
      ok: false,
      problem: { kind: "destination", problem: "malformed" },
    });
    expect(planWithdrawal(vault, coins, SIGNET, "")).toEqual({
      ok: false,
      problem: { kind: "amount" },
    });
    expect(planWithdrawal(vault, coins, SIGNET, "100")).toEqual({
      ok: false,
      problem: { kind: "amount" },
    });
    expect(planWithdrawal(vault, coins, SIGNET, "99999")).toEqual({
      ok: false,
      problem: { kind: "amount" },
    });
    expect(planWithdrawal(vault, [], SIGNET, "1000")).toEqual({
      ok: false,
      problem: { kind: "funds" },
    });
  });

  it("plans a Clawback of up to five coins, none without coins", () => {
    expect(planClawback(vault, [coin(1, 5000)])).toEqual({
      vault_id: "12",
      utxos: [coin(1, 5000)],
      fee_rate_sat_vb: 2,
    });
    expect(planClawback(vault, [])).toBeNull();
  });

  it("knows when a withdrawal is executable", () => {
    const op = { kind: "withdrawal", state: "pending", executable_at: "2000000000" } as SpendOp;
    expect(isExecutableAt(op, 1999)).toBe(false);
    expect(isExecutableAt(op, 2000)).toBe(true);
    expect(isExecutableAt({ ...op, state: "frozen" }, 3000)).toBe(false);
  });
});

describe("reading the contract", () => {
  it("finds the new Vault id in the return value, else in the vault_created event", () => {
    expect(createdVaultId("21", [])).toBe("21");
    const event = `EVENT_JSON:${JSON.stringify({
      standard: "morrow",
      event: "vault_created",
      data: [{ vault_id: "22", payload: {} }],
    })}`;
    expect(createdVaultId(null, ["noise", "EVENT_JSON:{bad", event])).toBe("22");
    expect(createdVaultId(null, [])).toBeNull();
  });

  it("refuses an op whose executable_at is not a u64 or null", () => {
    expect(asSpendOp(frozen("withdrawal"))).not.toBeNull();
    expect(asSpendOp({ ...frozen("withdrawal"), executable_at: "5" })).not.toBeNull();
    expect(asSpendOp({ ...frozen("withdrawal"), executable_at: "soon" })).toBeNull();
    expect(asSpendOp({ ...frozen("withdrawal"), executable_at: 5 })).toBeNull();
  });

  it("reads a get_vault view, an older one without pending_change included", () => {
    const view = {
      vault_id: "7",
      owner_account: "a.testnet",
      owner_key: "02",
      state: "active",
      policy: { guardians: [], btc_network: "signet" },
    };
    expect(asVault(view)?.pending_change).toBeNull();
    expect(asVault({ ...view, policy: null })).toBeNull();
  });
});

describe("broadcast", () => {
  const signal = new AbortController().signal;
  const hex = UNSIGNED;

  it("posts the hex to /tx and returns the txid", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response("ab".repeat(32)));
    vi.stubGlobal("fetch", fetchMock);
    expect(await broadcastTx("https://mempool.space/signet/api/", hex, signal)).toEqual({
      ok: true,
      txid: "ab".repeat(32),
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://mempool.space/signet/api/tx");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: hex });
  });

  it("counts a transaction the node already has as broadcast, with its own txid", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}',
          {
            status: 400,
          },
        ),
    );
    expect(await broadcastTx("https://b", hex, signal)).toEqual({ ok: true, txid: txidOf(hex) });
  });

  it("reports a refusal or no answer", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("bad-txns-inputs-missingorspent", { status: 400 }),
    );
    expect(await broadcastTx("https://b", hex, signal)).toEqual({
      ok: false,
      message: "bad-txns-inputs-missingorspent",
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect(await broadcastTx("https://b", hex, signal)).toEqual({ ok: false, message: null });
  });
});

const SCRIPT = "51";
const STORED = `02${"33".repeat(32)}${"44".repeat(32)}`;

function frozen(kind: "withdrawal" | "clawback", signatures: (string | null)[] = [null]): SpendOp {
  return {
    op_id: "30",
    vault_id: "12",
    kind,
    source: "vault",
    state: "frozen",
    amount_sats: "10000",
    destination: SIGNET,
    fee_rate_sat_vb: 2,
    utxos: [coin(1, 20_000)],
    created_at: "1",
    executable_at: null,
    unsigned_tx_hex: UNSIGNED,
    sighashes: ["55".repeat(32)],
    signatures,
    witness_template:
      kind === "withdrawal"
        ? {
            path: "withdrawal",
            slots: [
              { kind: "signature", signer: "cosigner" },
              { kind: "signature", signer: "owner" },
              { kind: "selector", hex: "01" },
              { kind: "script" },
            ],
          }
        : {
            path: "clawback",
            slots: [
              { kind: "empty" },
              { kind: "signature", signer: "guardian" },
              { kind: "signature", signer: "cosigner" },
              { kind: "selector", hex: "01" },
              { kind: "empty" },
              { kind: "script" },
            ],
          },
  };
}

/** Deps answering from fixed tables, recording every call. */
function fakeDeps(
  calls: Record<string, CallOutcome[]>,
  views: Record<string, ViewAnswer[]>,
  broadcast: ActionDeps["broadcast"] = async (hex) => ({ ok: true, txid: txidOf(hex) }),
) {
  const log: string[] = [];
  const sent: string[] = [];
  const deps: ActionDeps = {
    call: async (method, args) => {
      log.push(`call ${method} ${JSON.stringify(args)}`);
      const next = calls[method]?.shift();
      if (!next) throw new Error(`unexpected call ${method}`);
      return next;
    },
    view: async (method, args) => {
      log.push(`view ${method} ${JSON.stringify(args)}`);
      const next = views[method]?.shift();
      if (!next) throw new Error(`unexpected view ${method}`);
      return next;
    },
    broadcast: async (hex) => {
      sent.push(hex);
      return broadcast(hex);
    },
    sleep: async () => undefined,
  };
  return { deps, log, sent };
}

const ok = (value: unknown): CallOutcome => ({ kind: "ok", value, hash: "H", logs: [] });
const kit: ViewAnswer = {
  kind: "ok",
  value: { vault_script_hex: SCRIPT, allowance_script_hex: "52" },
};

describe("the flows", () => {
  const guardianSecret = new Uint8Array(32).fill(3);
  const ownerSecret = new Uint8Array(32).fill(4);

  it("claws back: begin_clawback, get_op, sign_input, assemble with the Guardian Key, broadcast", async () => {
    const steps: ActionStep[] = [];
    const { deps, log, sent } = fakeDeps(
      { begin_clawback: [ok("30")], sign_input: [ok(STORED)] },
      {
        get_vault_kit: [kit],
        get_op: [
          { kind: "error", code: "ERR_OP_NOT_FOUND" },
          { kind: "ok", value: frozen("clawback") },
        ],
      },
    );
    const result = await runClawback(
      deps,
      { vault, outpoints: [coin(1, 20_000)], guardianSecret },
      (step) => steps.push(step),
    );
    const expected = assembleSpendHex(frozen("clawback", [STORED]), SCRIPT, {
      role: "guardian",
      secretKey: guardianSecret,
    });
    expect(sent).toEqual([expected]);
    expect(result).toEqual({ kind: "broadcast", txid: txidOf(expected), opId: "30" });
    expect(log).toEqual([
      `call begin_clawback ${JSON.stringify({ vault_id: "12", utxos: [coin(1, 20_000)], fee_rate_sat_vb: 2 })}`,
      'view get_op {"op_id":"30"}',
      'view get_op {"op_id":"30"}',
      'view get_vault_kit {"vault_id":"12"}',
      'call sign_input {"op_id":"30","input_index":0}',
    ]);
    expect(steps.map((s) => (s.kind === "wallet" ? s.method : s.kind))).toEqual([
      "begin_clawback",
      "reading",
      "sign_input",
      "broadcasting",
    ]);
    expect(compressedPublicKey(guardianSecret)).toMatch(/^0[23]/);
  });

  it("executes: begin_execute returns the frozen op; a stored signature is not asked for again", async () => {
    const { deps, log, sent } = fakeDeps(
      { begin_execute: [ok(frozen("withdrawal", [STORED]))] },
      { get_vault_kit: [kit] },
    );
    const result = await runExecute(deps, { vault, opId: "30", ownerSecret }, () => undefined);
    const expected = assembleSpendHex(frozen("withdrawal", [STORED]), SCRIPT, ownerSecret);
    expect(sent).toEqual([expected]);
    expect(result).toMatchObject({ kind: "broadcast", txid: txidOf(expected) });
    expect(log.filter((l) => l.startsWith("call"))).toHaveLength(1);
    expect(log[0]).toMatch(/^call begin_execute \{"op_id":"30","envelope":"[0-9a-f]{160}"\}$/);
    expect(log[1]).toBe('view get_vault_kit {"vault_id":"12"}');
  });

  it("executes with the witness script of the frozen op's own source", async () => {
    const allowanceOp = { ...frozen("withdrawal", [STORED]), source: "allowance" as const };
    const { deps, sent } = fakeDeps({ begin_execute: [ok(allowanceOp)] }, { get_vault_kit: [kit] });
    await runExecute(deps, { vault, opId: "30", ownerSecret }, () => undefined);
    expect(sent).toEqual([assembleSpendHex(allowanceOp, "52", ownerSecret)]);
  });

  it("resumes a stopped Clawback by its op id, without a second begin_clawback", async () => {
    // The first press stops at sign_input; the op id comes back with the failure.
    const first = fakeDeps(
      { begin_clawback: [ok("30")], sign_input: [{ kind: "rejected", message: "User rejected" }] },
      { get_vault_kit: [kit], get_op: [{ kind: "ok", value: frozen("clawback") }] },
    );
    expect(
      await runClawback(
        first.deps,
        { vault, outpoints: [coin(1, 20_000)], guardianSecret },
        () => undefined,
      ),
    ).toEqual({ kind: "rejected", message: "User rejected", opId: "30" });
    // The second press carries op 30 on.
    const second = fakeDeps(
      { sign_input: [ok(STORED)] },
      { get_vault_kit: [kit], get_op: [{ kind: "ok", value: frozen("clawback") }] },
    );
    const result = await runClawback(
      second.deps,
      { vault, outpoints: [coin(1, 20_000)], guardianSecret, resumeOpId: "30" },
      () => undefined,
    );
    expect(result).toMatchObject({ kind: "broadcast", opId: "30" });
    expect(second.log.some((l) => l.startsWith("call begin_clawback"))).toBe(false);
    expect(second.sent).toHaveLength(1);
  });

  it("names the started Clawback when NEAR does not show its op", async () => {
    const { deps } = fakeDeps(
      { begin_clawback: [ok("30")] },
      { get_op: [{ kind: "error", code: "ERR_UNAUTHORIZED" }] },
    );
    expect(
      await runClawback(deps, { vault, outpoints: [coin(1, 1)], guardianSecret }, () => undefined),
    ).toEqual({ kind: "unreadable", opId: "30" });
  });

  it("retries a generic RPC error while reading an op back", async () => {
    const op = { ...frozen("withdrawal"), state: "pending", executable_at: "5" };
    const { deps } = fakeDeps(
      { request_withdrawal: [ok("31")] },
      {
        get_op: [
          { kind: "error", code: null },
          { kind: "ok", value: op },
        ],
      },
    );
    const plan = planWithdrawal(vault, [coin(1, 100_000)], SIGNET, "50000");
    if (!plan.ok) throw new Error("plan");
    expect(await runRequest(deps, plan.args, () => undefined)).toMatchObject({ op });
  });

  it("reads the signatures back when sign_input's answer has none", async () => {
    const { deps, sent } = fakeDeps(
      { begin_execute: [ok(frozen("withdrawal"))], sign_input: [ok(null)] },
      {
        get_vault_kit: [kit],
        get_op: [
          { kind: "ok", value: frozen("withdrawal") },
          { kind: "ok", value: frozen("withdrawal", [STORED]) },
        ],
      },
    );
    const result = await runExecute(deps, { vault, opId: "30", ownerSecret }, () => undefined);
    expect(result.kind).toBe("broadcast");
    expect(sent).toHaveLength(1);
  });

  it("stops at a refusal or a rejection, before anything reaches Bitcoin", async () => {
    const refused = fakeDeps(
      {
        begin_execute: [
          { kind: "refused", code: "ERR_NOT_EXECUTABLE", message: "ERR_NOT_EXECUTABLE", hash: "H" },
        ],
      },
      { get_vault_kit: [kit] },
    );
    expect(
      await runExecute(refused.deps, { vault, opId: "30", ownerSecret }, () => undefined),
    ).toEqual({
      kind: "refused",
      code: "ERR_NOT_EXECUTABLE",
      message: "ERR_NOT_EXECUTABLE",
    });
    expect(refused.sent).toEqual([]);
    const rejected = fakeDeps(
      { begin_clawback: [ok("30")], sign_input: [{ kind: "rejected", message: "User rejected" }] },
      { get_vault_kit: [kit], get_op: [{ kind: "ok", value: frozen("clawback") }] },
    );
    expect(
      await runClawback(
        rejected.deps,
        { vault, outpoints: [coin(1, 1)], guardianSecret },
        () => undefined,
      ),
    ).toEqual({ kind: "rejected", message: "User rejected", opId: "30" });
    expect(rejected.sent).toEqual([]);
  });

  it("keeps the signed transaction when the backend refuses it", async () => {
    const { deps } = fakeDeps(
      { begin_execute: [ok(frozen("withdrawal", [STORED]))] },
      { get_vault_kit: [kit] },
      async () => ({ ok: false, message: "min relay fee not met" }),
    );
    const result = await runExecute(deps, { vault, opId: "30", ownerSecret }, () => undefined);
    expect(result).toMatchObject({
      kind: "broadcast-failed",
      message: "min relay fee not met",
      opId: "30",
    });
  });

  it("requests a withdrawal and reads the op back", async () => {
    const op = { ...frozen("withdrawal"), state: "pending", executable_at: "5" };
    const { deps } = fakeDeps(
      { request_withdrawal: [ok("31")] },
      { get_op: [{ kind: "ok", value: op }] },
    );
    const plan = planWithdrawal(vault, [coin(1, 100_000)], SIGNET, "50000");
    if (!plan.ok) throw new Error("plan");
    expect(await runRequest(deps, plan.args, () => undefined)).toEqual({
      kind: "requested",
      opId: "31",
      op,
      hash: "H",
    });
  });
});

describe("waitForActive", () => {
  const active = {
    vault_id: "9",
    owner_account: "a",
    owner_key: "02",
    state: "active",
    policy: { guardians: [], btc_network: "signet" },
  };

  it("treats not found, not active, a generic RPC error and no answer as transient", async () => {
    const answers: ViewAnswer[] = [
      { kind: "error", code: "ERR_VAULT_NOT_FOUND" },
      { kind: "unreachable" },
      { kind: "error", code: "ERR_VAULT_NOT_ACTIVE" },
      { kind: "error", code: null },
      { kind: "ok", value: { ...active, state: "pending_keys" } },
      { kind: "ok", value: active },
    ];
    const vaultRead = await waitForActive(
      async () => answers.shift() ?? { kind: "unreachable" },
      async () => undefined,
      "9",
    );
    expect(vaultRead?.state).toBe("active");
    expect(answers).toEqual([]);
  });

  it("gives up on another error, or after its attempts", async () => {
    expect(
      await waitForActive(
        async () => ({ kind: "error", code: "ERR_UNAUTHORIZED" }),
        async () => undefined,
        "9",
      ),
    ).toBeNull();
    let reads = 0;
    const never = async (): Promise<ViewAnswer> => {
      reads += 1;
      return { kind: "unreachable" };
    };
    expect(await waitForActive(never, async () => undefined, "9", 3)).toBeNull();
    expect(reads).toBe(3);
  });
});

describe("actionGate", () => {
  const OWNER = "owner.testnet";
  const GUARDIAN = "guardian.testnet";
  const NOW = 1_000_000;
  const base: GateInput = {
    running: null,
    account: OWNER,
    vault: {
      owner_account: OWNER,
      state: "active",
      policy: {
        guardians: [{ guardian_key: "02", guardian_account: GUARDIAN, kind: "backup_device" }],
      } as unknown as Vault["policy"],
    },
    keysLoaded: true,
    op: null,
    coins: [coin(1, 50_000)],
    nowMs: NOW,
  };
  const pendingOp = (executableAtMs: number) =>
    ({
      ...frozen("withdrawal"),
      state: "pending",
      executable_at: (BigInt(executableAtMs) * 1_000_000n).toString(),
    }) as SpendOp;
  const guardianAlso = {
    ...base.vault,
    policy: {
      ...base.vault.policy,
      guardians: [{ guardian_key: "02", guardian_account: OWNER, kind: "backup_device" as const }],
    },
  };

  it.each([
    ["no wallet", "request", { account: null }, "Connect a NEAR wallet first."],
    ["another action running", "clawback", { running: "request" }, "Another action is running."],
    [
      "a non-owner requests",
      "request",
      { account: GUARDIAN },
      `Only the Owner Account, ${OWNER}, can do this.`,
    ],
    [
      "a non-owner executes",
      "execute",
      { account: GUARDIAN },
      `Only the Owner Account, ${OWNER}, can do this.`,
    ],
    [
      "a non-guardian claws back",
      "clawback",
      { account: OWNER },
      "The connected account is not a Guardian of this Vault.",
    ],
    ["the guardian claws back", "clawback", { account: GUARDIAN }, null],
    ["no key file", "request", { keysLoaded: false }, "Load the key file first."],
    [
      "no key file to claw back",
      "clawback",
      { account: GUARDIAN, keysLoaded: false },
      "Load the key file first.",
    ],
    ["coins still loading", "request", { coins: "loading" }, "Reading the Vault's coins."],
    ["no coins", "request", { coins: [] }, "The Vault Address has no confirmed coins."],
    [
      "no coins to claw back",
      "clawback",
      { account: GUARDIAN, coins: [] },
      "The Vault Address has no confirmed coins.",
    ],
    ["a funded owner requests", "request", {}, null],
    ["Execute without a request", "execute", {}, null],
    ["Execute after executable_at", "execute", { op: pendingOp(NOW - 1) }, null],
    ["Execute at executable_at", "execute", { op: pendingOp(NOW) }, null],
    [
      "a request no longer pending",
      "execute",
      { op: { ...pendingOp(NOW - 1), state: "voided" } },
      "This request is no longer pending.",
    ],
    [
      "a clawed-back Vault requests",
      "request",
      { vault: { ...base.vault, state: "clawed_back" } },
      "The Vault was clawed back to its Recovery Address and is closed.",
    ],
    [
      "a clawed-back Vault executes",
      "execute",
      { vault: { ...base.vault, state: "clawed_back" } },
      "The Vault was clawed back to its Recovery Address and is closed.",
    ],
    [
      "a clawed-back Vault sweeps a late deposit",
      "clawback",
      { account: OWNER, vault: { ...guardianAlso, state: "clawed_back" } },
      null,
    ],
    [
      "a Vault still deriving keys",
      "clawback",
      { account: GUARDIAN, vault: { ...base.vault, state: "pending_keys" } },
      "The Vault is not active yet.",
    ],
  ] as const)("%s: %s", (_, action, patch, expected) => {
    expect(actionGate(action, { ...base, ...(patch as Partial<GateInput>) })).toBe(expected);
  });

  it("Execute before executable_at names the absolute time it opens", () => {
    const reason = actionGate("execute", { ...base, op: pendingOp(NOW + 3_600_000) });
    expect(reason).toMatch(/^Execute opens at .*\d{2}:\d{2}\.$/);
  });
});
