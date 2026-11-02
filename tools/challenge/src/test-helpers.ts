import {
  MockContractClient,
  type BitcoinBackend,
  type ContractClient,
  type TxStatus,
  type Utxo,
} from "@morrow/core-ts";
import { networks, payments, Transaction } from "bitcoinjs-lib";
import type { RoundNear } from "./round.js";

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
  async getTipHeight(): Promise<number> {
    return 210;
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
