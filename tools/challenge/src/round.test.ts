import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  hexToBytes,
  MIN_VAULT_STORAGE_YOCTO,
  MockContractClient,
} from "@morrow/core-ts";
import { address as baddress, networks, Transaction } from "bitcoinjs-lib";
import { KeyPair } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import { FUNCTION_CALL_ALLOWANCE_YOCTO, ROUND_ACCOUNT_YOCTO, nearRound } from "./near.js";
import { RecoveryWallet } from "./recovery-wallet.js";
import { openRound, refreshDeadline, type OpenRoundOptions } from "./round.js";
import { FileRoundStore, InMemoryRoundStore, rotationDeadline, type RoundStore } from "./store.js";
import {
  CONTRACT,
  FakeBackend,
  GUARDIAN,
  GUARDIAN_KEY,
  PARENT,
  RECOVERY_SECRET,
  X25519,
  mockNear,
} from "./test-helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(store: RoundStore = new InMemoryRoundStore()) {
  const mock = new MockContractClient({ allowedNetworks: ["signet"] });
  const backend = new FakeBackend();
  const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
  backend.fund(wallet.address, 1_000_000);
  const near = mockNear(mock);
  const open = (overrides: Partial<OpenRoundOptions> = {}) =>
    openRound({
      store,
      near: near.near,
      wallet,
      ownerParent: PARENT,
      vaultContract: CONTRACT,
      nearNetwork: "testnet",
      policy: {
        guardianAccount: GUARDIAN,
        guardianKey: GUARDIAN_KEY,
        watcherX25519Pk: X25519,
        fundSats: 100_000n,
      },
      ...overrides,
    });
  return { mock, backend, wallet, near, store, open };
}

describe("openRound", () => {
  it("opens round 1: Owner Account, active Vault, function-call key, Vault Address funded, persisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "morrow-challenge-"));
    dirs.push(dir);
    const path = join(dir, "state", "rounds.json");
    const t = setup(new FileRoundStore(path));
    const round = await t.open();

    expect(round).toMatchObject({
      round: 1,
      status: "open",
      vault_contract: CONTRACT,
      near_network: "testnet",
      btc_network: "signet",
      owner_account: `r1.${PARENT}`,
      vault_id: "1",
      function_call_key_added: true,
      fund_sats: "100000",
      funding_height: null,
      rotation_deadline_height: null,
      failed_step: null,
    });
    // Fresh keys: the Owner Key matches its secret; the NEAR keys parse and differ.
    expect(round.owner_key).toBe(
      bytesToHex(secp256k1.getPublicKey(hexToBytes(round.owner_key_secret), true)),
    );
    const fcKey = KeyPair.fromString(round.near_function_call_key as never);
    expect(fcKey.getPublicKey().toString()).toBe(round.near_function_call_public_key);
    expect(round.near_function_call_key).not.toBe(round.owner_account_full_access_key);
    expect(t.near.accounts.get(round.owner_account)).toBe(
      KeyPair.fromString(round.owner_account_full_access_key as never)
        .getPublicKey()
        .toString(),
    );
    expect(t.near.functionCallKeys).toEqual([
      { accountId: round.owner_account, publicKey: round.near_function_call_public_key },
    ]);

    const vault = await t.mock.getVault("1");
    expect(vault).toMatchObject({
      owner_account: `r1.${PARENT}`,
      owner_key: round.owner_key,
      state: "active",
      storage_balance: MIN_VAULT_STORAGE_YOCTO.toString(),
      policy: {
        allowance_limit_sats: "0",
        fast_approval: false,
        btc_network: "signet",
        recovery_address: t.wallet.address,
        guardians: [
          { guardian_account: GUARDIAN, guardian_key: GUARDIAN_KEY, kind: "auto_clawback" },
        ],
        watcher_x25519_pk: X25519,
      },
    });

    // Only the Vault Address is paid; the rest is change to the Recovery Address.
    const tx = Transaction.fromHex(t.backend.broadcasts[0]!);
    expect(tx.getId()).toBe(round.funding_txid);
    const paid = tx.outs.map((o) => baddress.fromOutputScript(o.script, networks.testnet));
    expect(paid).toEqual([round.vault_address, t.wallet.address]);
    expect(paid).not.toContain(round.allowance_address);
    expect(tx.outs[0]!.value).toBe(100_000n);

    const persisted = JSON.parse(await readFile(path, "utf8")) as { rounds: unknown[] };
    expect(persisted.rounds).toEqual([{ ...round, updated_at: expect.any(String) }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses an unsafe Policy and creates nothing", async () => {
    const t = setup();
    await expect(
      t.open({
        policy: {
          guardianAccount: GUARDIAN,
          guardianKey: GUARDIAN_KEY,
          watcherX25519Pk: X25519,
          fundSats: 100_000n,
          overrides: { allowance_limit_sats: "5000" },
        },
      }),
    ).rejects.toThrow("UNSAFE_POLICY: allowance_limit_sats");
    expect(t.near.accounts.size).toBe(0);
    expect(await t.store.rounds()).toEqual([]);
    expect(t.backend.broadcasts).toEqual([]);
  });

  it("refuses overrides of locked fields (Recovery Address, Guardians, …) and creates nothing", async () => {
    const t = setup();
    await expect(
      t.open({
        policy: {
          guardianAccount: GUARDIAN,
          guardianKey: GUARDIAN_KEY,
          watcherX25519Pk: X25519,
          fundSats: 100_000n,
          overrides: { recovery_address: `tb1qthief${"q".repeat(34)}` },
        },
      }),
    ).rejects.toThrow("UNSAFE_POLICY: recovery_address");
    expect(t.near.accounts.size).toBe(0);
    expect(await t.store.rounds()).toEqual([]);
  });

  it("refuses a Policy the contract would reject, before creating anything", async () => {
    const t = setup();
    await expect(
      t.open({
        policy: {
          guardianAccount: GUARDIAN,
          guardianKey: GUARDIAN_KEY,
          watcherX25519Pk: X25519,
          fundSats: 100_000n,
          overrides: { escape_timelock_blocks: 10 },
        },
      }),
    ).rejects.toThrow(/INVALID_POLICY: .*escape_timelock_blocks/);
    expect(t.near.accounts.size).toBe(0);
  });

  it("refuses when the Recovery balance is short, before creating anything", async () => {
    const t = setup();
    t.backend.utxos.clear();
    t.backend.fund(t.wallet.address, 100_100);
    await expect(t.open()).rejects.toThrow(/^RECOVERY_BALANCE_SHORT: spendable 100100 sats/);
    expect(t.near.accounts.size).toBe(0);
    expect(await t.store.rounds()).toEqual([]);
  });

  it("refuses while a round is open; --next opens round 2 under r2 and closes round 1", async () => {
    const t = setup();
    await t.open();
    await expect(t.open()).rejects.toThrow(/ROUND_OPEN: round 1 is open/);
    const second = await t.open({ next: true });
    expect(second).toMatchObject({ round: 2, owner_account: `r2.${PARENT}`, vault_id: "2" });
    const rounds = await t.store.rounds();
    expect(rounds.map((r) => [r.round, r.status])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    expect((await t.store.current())?.round).toBe(2);
  });

  it("names the failed step, records what exists, and needs --next afterwards", async () => {
    const t = setup();
    t.near.failures.addFunctionCallKey = new Error("RPC timeout");
    await expect(t.open()).rejects.toThrow("STEP_FAILED: function_call_key: RPC timeout");
    const [partial] = await t.store.rounds();
    expect(partial).toMatchObject({
      round: 1,
      status: "opening",
      failed_step: "function_call_key",
      last_error: "RPC timeout",
      vault_id: "1",
      function_call_key_added: false,
      funding_txid: null,
    });
    expect(partial!.vault_address).not.toBeNull();
    expect(await t.store.current()).toBeNull();
    expect(t.backend.broadcasts).toEqual([]);

    await expect(t.open()).rejects.toThrow(/ROUND_OPEN: round 1 is incomplete/);
    delete t.near.failures.addFunctionCallKey;
    expect((await t.open({ next: true })).round).toBe(2);
  });

  it("records the account and its key before creating it, so --next moves on to r2", async () => {
    const t = setup();
    // The account may have landed on chain even though the call threw.
    t.near.failures.createOwnerAccount = new Error("RPC timeout");
    await expect(t.open()).rejects.toThrow("STEP_FAILED: account: RPC timeout");
    const [partial] = await t.store.rounds();
    expect(partial).toMatchObject({
      round: 1,
      status: "opening",
      owner_account: `r1.${PARENT}`,
      failed_step: "account",
      vault_id: null,
    });
    expect(partial!.owner_account_full_access_key).toMatch(/^ed25519:/);
    delete t.near.failures.createOwnerAccount;
    await expect(t.open()).rejects.toThrow(
      /ROUND_OPEN: round 1 is incomplete \(failed at account\)/,
    );
    expect((await t.open({ next: true })).owner_account).toBe(`r2.${PARENT}`);
  });

  it("keeps serving the open round until --next has fully opened the new one", async () => {
    const t = setup();
    await t.open();
    t.near.failures.addFunctionCallKey = new Error("RPC timeout");
    await expect(t.open({ next: true })).rejects.toThrow(/STEP_FAILED: function_call_key/);
    expect((await t.store.rounds()).map((r) => [r.round, r.status])).toEqual([
      [1, "open"],
      [2, "opening"],
    ]);
    expect((await t.store.current())?.round).toBe(1);
    delete t.near.failures.addFunctionCallKey;
    await t.open({ next: true });
    expect((await t.store.rounds()).map((r) => [r.round, r.status])).toEqual([
      [1, "closed"],
      [2, "closed"],
      [3, "open"],
    ]);
  });

  it("fails the funding step when the coins are gone by then", async () => {
    const t = setup();
    const wallet = {
      address: t.wallet.address,
      plan: t.wallet.plan.bind(t.wallet),
      broadcast: t.wallet.broadcast.bind(t.wallet),
      prepare: async () => {
        throw new Error("RECOVERY_BALANCE_SHORT: spendable 0 sats");
      },
    };
    await expect(t.open({ wallet })).rejects.toThrow(/STEP_FAILED: funding/);
    expect((await t.store.rounds())[0]).toMatchObject({
      failed_step: "funding",
      function_call_key_added: true,
      funding_txid: null,
    });
  });

  it("records the funding txid before broadcasting; a tx the network knows counts as sent", async () => {
    const t = setup();
    t.backend.failBroadcast = "sent";
    const round = await t.open();
    expect(round.status).toBe("open");
    expect(round.funding_txid).toBe(Transaction.fromHex(t.backend.broadcasts[0]!).getId());
  });

  it("keeps the funding txid when the broadcast is lost, so a retry cannot fund twice unnoticed", async () => {
    const t = setup();
    t.backend.failBroadcast = "lost";
    await expect(t.open()).rejects.toThrow("STEP_FAILED: funding: connection reset");
    const [partial] = await t.store.rounds();
    expect(partial).toMatchObject({ status: "opening", failed_step: "funding" });
    expect(partial!.funding_txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("waits for the Vault to leave pending_keys", async () => {
    const t = setup();
    t.near.pending.reads = 3;
    const sleeps: number[] = [];
    const round = await t.open({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(round.vault_address).not.toBeNull();
  });

  it("fails the vault step when activation times out, with the vault id recorded", async () => {
    const t = setup();
    t.near.pending.reads = Number.POSITIVE_INFINITY;
    await expect(t.open({ activationTimeoutMs: 0 })).rejects.toThrow(
      "STEP_FAILED: vault: Vault 1 still pending_keys",
    );
    expect((await t.store.rounds())[0]).toMatchObject({
      failed_step: "vault",
      vault_id: "1",
      vault_address: null,
    });
  });
});

describe("rotation deadline", () => {
  it("is the funding confirmation height + 80% of the Escape Timelock; pending until then", async () => {
    expect(rotationDeadline(1_000, 26_280)).toBe(1_000 + 21_024);
    const t = setup();
    const round = await t.open();
    expect((await refreshDeadline(t.store, t.backend))?.rotation_deadline_height).toBeNull();
    t.backend.txs.set(round.funding_txid!, {
      txid: round.funding_txid!,
      confirmations: 1,
      block_height: 300,
    });
    const refreshed = await refreshDeadline(t.store, t.backend);
    expect(refreshed).toMatchObject({ funding_height: 300, rotation_deadline_height: 21_324 });
    const calls = t.backend.getTxCalls;
    await refreshDeadline(t.store, t.backend);
    expect(t.backend.getTxCalls).toBe(calls); // confirmed once is enough
  });

  it("never reopens a round that was closed meanwhile", async () => {
    const t = setup();
    const round = await t.open();
    await t.store.put({ ...round, status: "closed" });
    expect(await t.store.patchFunding(round.round, 300, 21_324)).toBeNull();
    expect((await t.store.rounds())[0]).toMatchObject({ status: "closed", funding_height: null });
  });
});

describe("nearRound", () => {
  it("creates r<N> under the parent and adds a contract-scoped, all-methods, 1 NEAR function-call key", async () => {
    const calls: { as: string; method: string; args: unknown }[] = [];
    const near = nearRound({
      rpcUrl: "http://127.0.0.1:1",
      vaultContract: CONTRACT,
      ownerParent: PARENT,
      parentKey: "ed25519:parent",
      account: (accountId) => ({
        createSubAccount: async (args) =>
          calls.push({ as: accountId, method: "createSubAccount", args }),
        addFunctionCallAccessKey: async (args) =>
          calls.push({ as: accountId, method: "addFunctionCallAccessKey", args }),
        getAccessKey: async () => ({ permission: "FullAccess" }),
        deleteKey: async () => undefined,
        getState: async () => ({ balance: { available: 0n } }),
        transfer: async () => undefined,
      }),
    });
    await near.createOwnerAccount(`r1.${PARENT}`, "ed25519:full");
    await near.addFunctionCallKey(`r1.${PARENT}`, "ed25519:secret", "ed25519:fc");
    expect(calls).toEqual([
      {
        as: PARENT,
        method: "createSubAccount",
        args: {
          accountOrPrefix: `r1.${PARENT}`,
          publicKey: "ed25519:full",
          nearToTransfer: ROUND_ACCOUNT_YOCTO,
        },
      },
      {
        as: `r1.${PARENT}`,
        method: "addFunctionCallAccessKey",
        args: {
          publicKey: "ed25519:fc",
          contractId: CONTRACT,
          methodNames: [],
          allowance: FUNCTION_CALL_ALLOWANCE_YOCTO,
        },
      },
    ]);
    expect(FUNCTION_CALL_ALLOWANCE_YOCTO).toBe(10n ** 24n);
    // Room for the 0.5 NEAR Vault deposit and the published key's 1 NEAR of gas.
    expect(ROUND_ACCOUNT_YOCTO).toBeGreaterThan(
      MIN_VAULT_STORAGE_YOCTO + FUNCTION_CALL_ALLOWANCE_YOCTO,
    );
  });
});
