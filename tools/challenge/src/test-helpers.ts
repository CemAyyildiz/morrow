import {
  MockContractClient,
  NearRpcError,
  type BitcoinBackend,
  type ContractClient,
  type RpcTxStatus,
  type TxStatus,
  type Utxo,
  type Vault,
} from "@morrow/core-ts";
import { networks, payments, Transaction } from "bitcoinjs-lib";
import type { AttemptSources } from "./attempts.js";
import type { RoundNear } from "./round.js";
import type { RunNear } from "./run.js";
import type { WatcherClient } from "./watcher-client.js";

export const PARENT = "challenge.testnet";
export const CONTRACT = "vault.testnet";
export const GUARDIAN = "watcher-guardian.testnet";
export const GUARDIAN_KEY = `03${"22".repeat(32)}`;
export const X25519 = "44".repeat(32);
export const RECOVERY_SECRET = "11".repeat(32);

export const txid = (n: number) => n.toString(16).padStart(64, "0");

/** A real (checksummed) signet P2WSH address, unique per seed. */
export function p2wshAddress(seed: number): string {
  const { address } = payments.p2wsh({
    redeem: { output: Uint8Array.of(0x01, seed & 0xff, 0x75, 0x51) },
    network: networks.testnet,
  });
  if (!address) throw new Error("no address");
  return address;
}

export class FakeBackend implements BitcoinBackend {
  readonly utxos = new Map<string, Utxo[]>();
  readonly txs = new Map<string, TxStatus>();
  readonly broadcasts: string[] = [];
  getTxCalls = 0;
  /** "sent": the tx reaches the network but the call throws; "lost": it never arrives. */
  failBroadcast: "sent" | "lost" | null = null;

  fund(address: string, ...values: number[]): void {
    const existing = this.utxos.get(address) ?? [];
    this.utxos.set(address, [
      ...existing,
      ...values.map((value, i) => ({
        txid: txid(1000 + existing.length + i),
        vout: i,
        value_sats: String(value),
        height: 200,
      })),
    ]);
  }
  async getUtxos(address: string): Promise<Utxo[]> {
    return this.utxos.get(address) ?? [];
  }
  /** Signet tip height. */
  tip = 210;
  async getTipHeight(): Promise<number> {
    return this.tip;
  }
  async getTx(id: string): Promise<TxStatus | null> {
    this.getTxCalls++;
    return this.txs.get(id) ?? null;
  }
  async broadcast(raw: string): Promise<string> {
    if (this.failBroadcast === "lost") throw new Error("connection reset");
    this.broadcasts.push(raw);
    const id = Transaction.fromHex(raw).getId();
    this.txs.set(id, { txid: id, confirmations: 0, block_height: null });
    if (this.failBroadcast === "sent") throw new Error("timeout after send");
    return "ignored";
  }
  async getSpender(): Promise<null> {
    return null;
  }
}

/**
 * `RoundNear` over the mock contract. Vault addresses are swapped for real signet addresses so
 * the Recovery Wallet can pay them; everything else is the mock.
 */
export function mockNear(mock: MockContractClient) {
  const accounts = new Map<string, string>();
  const functionCallKeys: { accountId: string; publicKey: string }[] = [];
  const failures: Partial<Record<keyof RoundNear, Error>> = {};
  /** getVault reports the Vault as pending_keys this many more times. */
  const pending = { reads: 0 };
  const near: RoundNear = {
    async createOwnerAccount(accountId, publicKey) {
      if (failures.createOwnerAccount) throw failures.createOwnerAccount;
      if (accounts.has(accountId)) throw new Error(`account ${accountId} already exists`);
      accounts.set(accountId, publicKey);
    },
    ownerClient(accountId) {
      if (failures.ownerClient) throw failures.ownerClient;
      return new Proxy(mock, {
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            target.asCaller(accountId);
            const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            if (prop === "getVault") {
              const vault = result as Awaited<ReturnType<ContractClient["getVault"]>>;
              const seed = Number(vault.vault_id);
              if (pending.reads > 0) {
                pending.reads--;
                vault.state = "pending_keys";
                vault.addresses = null;
              } else if (vault.addresses) {
                vault.addresses = {
                  vault: p2wshAddress(seed),
                  allowance: p2wshAddress(seed + 100),
                };
              }
            }
            return result;
          };
        },
      }) as ContractClient;
    },
    async addFunctionCallKey(accountId, _secretKey, publicKey) {
      if (failures.addFunctionCallKey) throw failures.addFunctionCallKey;
      functionCallKeys.push({ accountId, publicKey });
    },
  };
  return { near, accounts, functionCallKeys, failures, pending };
}

const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

/**
 * `RunNear` over the mock contract: `mockNear` plus Vault views, storage top-ups and the Owner
 * Accounts' function-call keys with their remaining allowance.
 */
export function mockRunNear(mock: MockContractClient) {
  const base = mockNear(mock);
  /** "account public-key" → remaining allowance (yocto). */
  const keys = new Map<string, bigint>();
  const keyId = (accountId: string, publicKey: string) => `${accountId} ${publicKey}`;
  const topUps: { vaultId: string; yocto: bigint }[] = [];
  const deleted: string[] = [];
  /** Owner Account available balances (default 2 NEAR) and parent transfers. */
  const balances = new Map<string, bigint>();
  const transfers: { accountId: string; yocto: bigint }[] = [];
  /** Fields laid over the mock's Vault views, e.g. a low `storage_balance`. */
  const vaultPatches = new Map<string, Partial<Vault>>();
  const failures: Partial<Record<keyof RunNear, Error>> = base.failures;
  const near: RunNear = {
    ...base.near,
    async addFunctionCallKey(accountId, secretKey, publicKey) {
      await base.near.addFunctionCallKey(accountId, secretKey, publicKey);
      keys.set(keyId(accountId, publicKey), ONE_NEAR);
    },
    async getVault(vaultId) {
      if (failures.getVault) throw failures.getVault;
      return { ...(await mock.getVault(vaultId)), ...vaultPatches.get(vaultId) };
    },
    async availableBalance(accountId) {
      if (failures.availableBalance) throw failures.availableBalance;
      return balances.get(accountId) ?? 2n * ONE_NEAR;
    },
    async transferFromParent(accountId, yocto) {
      if (failures.transferFromParent) throw failures.transferFromParent;
      transfers.push({ accountId, yocto });
      balances.set(accountId, (balances.get(accountId) ?? 2n * ONE_NEAR) + yocto);
    },
    async topUpStorage(vaultId, yocto) {
      if (failures.topUpStorage) throw failures.topUpStorage;
      topUps.push({ vaultId, yocto });
      await mock.topUpStorage(vaultId, yocto.toString());
    },
    async accessKey(accountId, _secretKey, publicKey) {
      if (failures.accessKey) throw failures.accessKey;
      const allowance = keys.get(keyId(accountId, publicKey));
      return allowance === undefined
        ? { exists: false }
        : { exists: true, allowanceYocto: allowance };
    },
    async deleteKey(accountId, _secretKey, publicKey) {
      if (failures.deleteKey) throw failures.deleteKey;
      if (!keys.delete(keyId(accountId, publicKey))) throw new Error("no such key");
      deleted.push(publicKey);
    },
  };
  const setAllowance = (accountId: string, publicKey: string, yocto: bigint | null) => {
    if (yocto === null) keys.delete(keyId(accountId, publicKey));
    else keys.set(keyId(accountId, publicKey), yocto);
  };
  return {
    ...base,
    near,
    failures,
    keys,
    topUps,
    deleted,
    setAllowance,
    vaultPatches,
    balances,
    transfers,
  };
}

/** The watcher's `POST /clawbacks`: claws the Vault back on the mock contract as its Guardian. */
export function fakeWatcher(mock: MockContractClient) {
  const requests: string[] = [];
  const state = { down: false };
  const watcher: WatcherClient = {
    async requestClawback(vaultId) {
      if (state.down) throw new Error("watcher unreachable: connect ECONNREFUSED");
      requests.push(vaultId);
      const vault = await mock.getVault(vaultId);
      if (vault.state !== "clawed_back") {
        await mock.asCaller(GUARDIAN).beginClawback({
          vault_id: vaultId,
          utxos: [{ txid: txid(9000 + Number(vaultId)), vout: 0, value_sats: "100000" }],
          fee_rate_sat_vb: 2,
        });
      }
      return { job_id: `job-${vaultId}`, status: "queued" };
    },
  };
  return { watcher, requests, state };
}

export interface FakeTx {
  hash: string;
  signer: string;
  receiver: string;
  method: string;
  blockTimestampNs: string;
  /** Undefined: success. A string: the contract panic text. An object: a raw NEAR Failure. */
  failure?: string | Record<string, unknown>;
}

function fakeTxStatus(tx: FakeTx): RpcTxStatus {
  const failure =
    tx.failure === undefined
      ? undefined
      : typeof tx.failure === "string"
        ? {
            ActionError: {
              index: 0,
              kind: {
                FunctionCallError: { ExecutionError: `Smart contract panicked: ${tx.failure}` },
              },
            },
          }
        : tx.failure;
  const status = failure === undefined ? { SuccessValue: "" } : { Failure: failure };
  const call = { FunctionCall: { method_name: tx.method, args: btoa("{}") } };
  return {
    status,
    transaction: { hash: tx.hash, signer_id: tx.signer, receiver_id: tx.receiver, actions: [call] },
    transaction_outcome: {
      id: tx.hash,
      block_hash: `${tx.hash}-block`,
      outcome: {
        executor_id: tx.signer,
        logs: [],
        receipt_ids: [`${tx.hash}-r`],
        status: { SuccessReceiptId: `${tx.hash}-r` },
      },
    },
    receipts: [
      {
        receipt_id: `${tx.hash}-r`,
        predecessor_id: tx.signer,
        receiver_id: tx.receiver,
        receipt: { Action: { actions: [call] } },
      },
    ],
    receipts_outcome: [
      {
        id: `${tx.hash}-r`,
        block_hash: `${tx.hash}-block`,
        outcome: { executor_id: tx.receiver, logs: [], receipt_ids: [], status },
      },
    ],
  };
}

/** FastNEAR (signer listing) and NEAR RPC (tx status) over an in-memory list of transactions. */
export function fakeChainSources() {
  const txs: FakeTx[] = [];
  const state = { indexerDown: false, unreadable: new Set<string>() };
  const statusCalls: string[] = [];
  const sources: AttemptSources = {
    async signedBy(accountId) {
      if (state.indexerDown) throw new Error("FastNEAR /v0/account: HTTP 503");
      return txs
        .filter((tx) => tx.signer === accountId)
        .map((tx) => ({ hash: tx.hash, blockTimestampNs: tx.blockTimestampNs }))
        .reverse();
    },
    async txStatus(hash, senderId) {
      statusCalls.push(hash);
      const tx = txs.find((t) => t.hash === hash && t.signer === senderId);
      if (!tx || state.unreadable.has(hash)) {
        throw new NearRpcError(
          "EXPERIMENTAL_tx_status: UNKNOWN_TRANSACTION",
          "UNKNOWN_TRANSACTION",
        );
      }
      return fakeTxStatus(tx);
    },
  };
  return { sources, txs, state, statusCalls };
}
