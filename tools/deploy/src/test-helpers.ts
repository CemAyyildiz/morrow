import type { InitArgs } from "./args.js";
import type { Wasm } from "./build.js";
import { codeHash } from "./build.js";
import type {
  AccessKeyEntry,
  AccountState,
  ChainReader,
  PlannedAction,
  Snapshot,
  TxSender,
} from "./rpc.js";
import { NO_CONTRACT_HASH } from "./rpc.js";

export const CODE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export const WASM: Wasm = { path: "/repo/morrow_vault.wasm", code: CODE, hash: codeHash(CODE) };
export const OTHER_HASH = "9cMqHrLTDUKZx3XRjgJRV9ZQdLMyqcfE5T4GRyhHg9vA";
export const VERSION = "0.1.0";
export const NEAR = 10n ** 24n;
export const STORAGE_PRICE = 10n ** 19n;

export const SIGNING_KEY = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";
export const SECOND_KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
export const GAS_KEY = "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB";
export const CALL_KEY = "ed25519:H9k5eiU4xyS1aTmLW5LSJmTaEe9x4vubzp1PqbSXuqcd";

export const TESTNET_INIT: InitArgs = {
  signer_account: "v1.signer-prod.testnet",
  allowed_networks: ["signet"],
  creator_allowlist: [],
};
export const TESTNET_CONFIG = { ...TESTNET_INIT, version: VERSION };
export const MAINNET_INIT: InitArgs = {
  signer_account: "v1.signer",
  allowed_networks: ["bitcoin"],
  creator_allowlist: ["bounty-operator.near"],
};
export const MAINNET_CONFIG = { ...MAINNET_INIT, version: VERSION };

export interface FakeAccount {
  codeHash: string;
  keys: AccessKeyEntry[];
  /** `get_config`'s answer; an Error makes the call fail. */
  config: unknown;
  amount: bigint;
  storageUsage: number;
}

/** An in-memory chain: views read `accounts`; a batch from `sender` applies its actions. */
export class FakeChain implements ChainReader {
  accounts = new Map<string, FakeAccount>();
  sent: { accountId: string; batch: PlannedAction[] }[] = [];
  down = false;
  chainId = "testnet";
  height = 1000;
  /** Keys a DeleteKey leaves in place (a lock that "fails"). */
  sticky = new Set<string>();
  /** Thrown by `send`; with `applyBeforeError` the batch still lands (a timeout after inclusion). */
  sendError: Error | null = null;
  applyBeforeError = false;

  add(accountId: string, account: Partial<FakeAccount> = {}): this {
    this.accounts.set(accountId, {
      codeHash: WASM.hash,
      keys: [],
      config: TESTNET_CONFIG,
      amount: 10n * NEAR,
      storageUsage: 182,
      ...account,
    });
    return this;
  }

  /** An empty, funded account ready for `deploy`. */
  addEmpty(accountId: string, account: Partial<FakeAccount> = {}): this {
    return this.add(accountId, {
      codeHash: NO_CONTRACT_HASH,
      config: new Error("CodeDoesNotExist"),
      ...account,
    });
  }

  private up() {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:3030");
  }

  async networkId() {
    this.up();
    return this.chainId;
  }

  async account(accountId: string): Promise<AccountState | null> {
    this.up();
    const a = this.accounts.get(accountId);
    return a ? { amount: a.amount, codeHash: a.codeHash, storageUsage: a.storageUsage } : null;
  }

  async snapshot(accountId: string): Promise<Snapshot> {
    this.up();
    this.height += 1;
    const a = this.accounts.get(accountId);
    if (!a) {
      return {
        blockHeight: this.height,
        account: null,
        keys: [],
        config: undefined,
        configError: null,
      };
    }
    const failed = a.config instanceof Error;
    return {
      blockHeight: this.height,
      account: { amount: a.amount, codeHash: a.codeHash, storageUsage: a.storageUsage },
      keys: a.keys.map((k) => ({ ...k })),
      config: failed ? undefined : a.config,
      configError: failed ? (a.config as Error).message : null,
    };
  }

  async storagePricePerByte() {
    this.up();
    return STORAGE_PRICE;
  }

  sender(accountId: string, publicKey = SIGNING_KEY): TxSender {
    return {
      accountId,
      publicKey,
      send: async (batch) => {
        this.sent.push({ accountId, batch });
        if (this.sendError && !this.applyBeforeError) throw this.sendError;
        const account = this.accounts.get(accountId);
        if (!account) throw new Error(`account ${accountId} does not exist`);
        for (const action of batch) {
          if (action.kind === "deployContract") account.codeHash = codeHash(action.code);
          if (action.kind === "deleteKey" && !this.sticky.has(action.publicKey)) {
            account.keys = account.keys.filter((k) => k.publicKey !== action.publicKey);
          }
        }
        if (this.sendError) throw this.sendError;
        return "TxHash1111111111111111111111111111111111111";
      },
    };
  }
}

export const full = (publicKey: string): AccessKeyEntry => ({
  publicKey,
  permission: "FullAccess",
});
export const gasFull = (publicKey: string): AccessKeyEntry => ({
  publicKey,
  permission: { GasKeyFullAccess: { balance: "0", num_nonces: 4 } },
});
export const functionCall = (publicKey: string): AccessKeyEntry => ({
  publicKey,
  permission: { FunctionCall: { allowance: null, method_names: [], receiver_id: "x.testnet" } },
});

export function output() {
  const lines: string[] = [];
  return { lines, out: (line: string) => void lines.push(line), text: () => lines.join("\n") };
}
