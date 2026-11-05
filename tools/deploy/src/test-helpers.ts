import type { Wasm } from "./build.js";
import { codeHash } from "./build.js";
import type { AccessKeyEntry, ChainReader, PlannedAction, TxSender } from "./rpc.js";

export const CODE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export const WASM: Wasm = { path: "/repo/morrow_vault.wasm", code: CODE, hash: codeHash(CODE) };
export const OTHER_HASH = "9cMqHrLTDUKZx3XRjgJRV9ZQdLMyqcfE5T4GRyhHg9vA";

export const SIGNING_KEY = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";
export const SECOND_KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
export const GAS_KEY = "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB";
export const CALL_KEY = "ed25519:H9k5eiU4xyS1aTmLW5LSJmTaEe9x4vubzp1PqbSXuqcd";

export const TESTNET_CONFIG = {
  signer_account: "v1.signer-prod.testnet",
  allowed_networks: ["signet"],
  creator_allowlist: [],
  version: "0.1.0",
};

export interface FakeAccount {
  codeHash: string;
  keys: AccessKeyEntry[];
  config: unknown;
}

/** An in-memory chain: views read `accounts`; a batch from `sender` applies its DeleteKeys. */
export class FakeChain implements ChainReader {
  accounts = new Map<string, FakeAccount>();
  sent: { accountId: string; batch: PlannedAction[] }[] = [];
  down = false;
  /** Keys a DeleteKey leaves in place (a lock that "fails"). */
  sticky = new Set<string>();

  add(accountId: string, account: Partial<FakeAccount> = {}): this {
    this.accounts.set(accountId, {
      codeHash: WASM.hash,
      keys: [],
      config: TESTNET_CONFIG,
      ...account,
    });
    return this;
  }

  private get(accountId: string): FakeAccount {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:3030");
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`account ${accountId} does not exist while viewing`);
    return account;
  }

  async codeHash(accountId: string) {
    return this.get(accountId).codeHash;
  }
  async accessKeys(accountId: string) {
    return this.get(accountId).keys.map((k) => ({ ...k }));
  }
  async getConfig(accountId: string) {
    const config = this.get(accountId).config;
    if (config instanceof Error) throw config;
    return config;
  }

  sender(accountId: string, publicKey = SIGNING_KEY): TxSender {
    return {
      accountId,
      publicKey,
      send: async (batch) => {
        this.sent.push({ accountId, batch });
        const account = this.get(accountId);
        for (const action of batch) {
          if (action.kind === "deleteKey" && !this.sticky.has(action.publicKey)) {
            account.keys = account.keys.filter((k) => k.publicKey !== action.publicKey);
          }
        }
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
