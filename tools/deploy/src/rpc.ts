import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  actions,
  type Action,
  type KeyPairString,
} from "near-api-js";
import { UsageError, type NearNetwork } from "./args.js";

/** The code hash of an account with no contract (32 zero bytes, base58). */
export const NO_CONTRACT_HASH = "11111111111111111111111111111111";

export type PlannedAction =
  | { kind: "deployContract"; code: Uint8Array }
  | {
      kind: "functionCall";
      method: string;
      args: Record<string, unknown>;
      gas: bigint;
      deposit: bigint;
    }
  | { kind: "deleteKey"; publicKey: string };

export interface AccessKeyEntry {
  publicKey: string;
  /** The RPC's permission view: "FullAccess", { FunctionCall }, { GasKeyFullAccess }, … */
  permission: unknown;
}

/** Read-only chain views. Every command reads through this; tests pass a fake. */
export interface ChainReader {
  codeHash(accountId: string): Promise<string>;
  accessKeys(accountId: string): Promise<AccessKeyEntry[]>;
  getConfig(accountId: string): Promise<unknown>;
}

/** Signs and sends one batch transaction from the account to itself; returns the tx hash. */
export interface TxSender {
  readonly accountId: string;
  /** The signing key's public key ("ed25519:…"). */
  readonly publicKey: string;
  send(batch: PlannedAction[]): Promise<string>;
}

/**
 * Whether a key can change the account. `FullAccess` and `GasKeyFullAccess` can deploy code or
 * delete the account; function-call keys (plain or gas) cannot. A permission this tool does not
 * recognise counts as full access, so a new key kind can never make an account look locked.
 */
export function isFullAccess(permission: unknown): boolean {
  if (typeof permission === "object" && permission !== null) {
    const kinds = Object.keys(permission);
    return !(
      kinds.length === 1 &&
      (kinds[0] === "FunctionCall" || kinds[0] === "GasKeyFunctionCall")
    );
  }
  return true;
}

export function fullAccessKeys(keys: AccessKeyEntry[]): AccessKeyEntry[] {
  return keys.filter((k) => isFullAccess(k.permission));
}

export function nearReader(rpcUrl: string): ChainReader {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    async codeHash(accountId) {
      return String((await provider.viewAccount({ accountId })).code_hash);
    },
    async accessKeys(accountId) {
      const list = await provider.viewAccessKeyList({ accountId });
      return list.keys.map((k) => ({
        publicKey: String(k.public_key),
        permission: k.access_key.permission,
      }));
    },
    async getConfig(accountId) {
      return provider.callFunction({ contractId: accountId, method: "get_config", args: {} });
    },
  };
}

function toNearAction(action: PlannedAction): Action {
  switch (action.kind) {
    case "deployContract":
      return actions.deployContract(action.code);
    case "functionCall":
      return actions.functionCall(action.method, action.args, action.gas, action.deposit);
    case "deleteKey":
      return actions.deleteKey(PublicKey.from(action.publicKey));
  }
}

export function nearSender(rpcUrl: string, accountId: string, key: KeyPair): TxSender {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(accountId, provider, new KeyPairSigner(key));
  return {
    accountId,
    publicKey: key.getPublicKey().toString(),
    async send(batch) {
      const outcome = await account.signAndSendTransaction({
        receiverId: accountId,
        actions: batch.map(toNearAction),
        throwOnFailure: true,
      });
      return String(outcome.transaction.hash);
    },
  };
}

export const KEY_ENV = "MORROW_DEPLOY_PRIVATE_KEY";

function keyPair(secret: unknown, source: string): KeyPair {
  if (typeof secret !== "string") throw new UsageError(`${source} holds no private key`);
  try {
    return KeyPair.fromString(secret as KeyPairString);
  } catch {
    // The near-api-js message could quote the value: never pass it on.
    throw new UsageError(`${source} is not a valid NEAR private key`);
  }
}

/**
 * The account's signing key: `MORROW_DEPLOY_PRIVATE_KEY`, else the near-api-js credential file
 * `~/.near-credentials/<network>/<account>.json`. Only the source is ever named, never the key.
 */
export function loadSigningKey(
  accountId: string,
  network: NearNetwork,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): KeyPair {
  const fromEnv = env[KEY_ENV];
  if (fromEnv) return keyPair(fromEnv, KEY_ENV);
  const file = join(home, ".near-credentials", network, `${accountId}.json`);
  if (!existsSync(file)) {
    throw new UsageError(`No key for ${accountId}: set ${KEY_ENV} or create ${file}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new UsageError(`${file} is not valid JSON`);
  }
  if (parsed.account_id !== undefined && parsed.account_id !== accountId) {
    throw new UsageError(`${file} is for ${String(parsed.account_id)}, not ${accountId}`);
  }
  return keyPair(parsed.private_key ?? parsed.secret_key, file);
}
