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

export interface AccountState {
  /** Liquid balance in yoctoNEAR (it includes what storage reserves). */
  amount: bigint;
  codeHash: string;
  storageUsage: number;
}

/** One account read at one final block. `account` is null when it does not exist. */
export interface Snapshot {
  blockHeight: number;
  account: AccountState | null;
  keys: AccessKeyEntry[];
  /** `get_config`'s JSON, or undefined when the call failed (`configError`). */
  config: unknown;
  configError: string | null;
}

/** Read-only chain views. Every command reads through this; tests pass a fake. */
export interface ChainReader {
  /** The RPC's own `chain_id` ("testnet", "mainnet"). */
  networkId(): Promise<string>;
  /** The account at the final block, or null when it does not exist. */
  account(accountId: string): Promise<AccountState | null>;
  /** Account, access keys and `get_config`, all at the same final block. */
  snapshot(accountId: string): Promise<Snapshot>;
  /** The protocol's storage price, yoctoNEAR per byte. */
  storagePricePerByte(): Promise<bigint>;
}

/** Signs and sends one batch transaction from the account to itself; returns the tx hash. */
export interface TxSender {
  readonly accountId: string;
  /** The signing key's public key ("ed25519:…"). */
  readonly publicKey: string;
  send(batch: PlannedAction[]): Promise<string>;
}

/**
 * Whether a key can sign DeployContract or DeleteKey. `FullAccess` and `GasKeyFullAccess` can;
 * function-call keys (plain or gas) cannot. An unrecognised permission counts as full access.
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

/** A one-line description of a key's permission, for reports. */
export function describePermission(permission: unknown): string {
  if (permission === "FullAccess") return "FullAccess";
  if (typeof permission === "object" && permission !== null) {
    const [kind, body] = Object.entries(permission)[0] ?? [];
    if (kind === "GasKeyFullAccess") return "GasKeyFullAccess";
    if ((kind === "FunctionCall" || kind === "GasKeyFunctionCall") && body) {
      const b = body as { receiver_id?: unknown; method_names?: unknown };
      const methods =
        Array.isArray(b.method_names) && b.method_names.length > 0
          ? b.method_names.join(",")
          : "any";
      return `${kind} receiver ${String(b.receiver_id)}, methods ${methods}`;
    }
  }
  return JSON.stringify(permission);
}

interface RpcError {
  name?: string;
  cause?: { name?: string };
  message?: string;
  data?: unknown;
}

/** An RPC answer that is an error, with the node's error name (e.g. UNKNOWN_ACCOUNT). */
export class NearRpcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

const isMissingAccount = (error: unknown) =>
  error instanceof NearRpcError &&
  (error.kind === "UNKNOWN_ACCOUNT" || /does not exist/i.test(error.message));

/**
 * Views over plain NEAR JSON-RPC. Each snapshot fetches the final block once and queries the
 * account, its keys and `get_config` at that block height.
 */
export function nearReader(rpcUrl: string, fetchFn: typeof fetch = fetch): ChainReader {
  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "morrow-deploy", method, params }),
    });
    if (!response.ok) throw new NearRpcError("HTTP", `${rpcUrl}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: RpcError };
    if (body.error) {
      const kind = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
      const detail =
        typeof body.error.data === "string" ? body.error.data : (body.error.message ?? "");
      throw new NearRpcError(kind, `${kind}: ${detail}`);
    }
    const result = body.result as { error?: unknown } | undefined;
    // Older nodes answer some query failures inside `result`.
    if (result && typeof result.error === "string") {
      throw new NearRpcError("QUERY_ERROR", result.error);
    }
    return body.result as T;
  }

  const query = <T>(request: Record<string, unknown>, block: { block_id: number } | null) =>
    rpc<T>("query", { ...request, ...(block ?? { finality: "final" }) });

  async function accountAt(accountId: string, block: { block_id: number } | null) {
    try {
      const view = await query<{ amount: string; code_hash: string; storage_usage: number }>(
        { request_type: "view_account", account_id: accountId },
        block,
      );
      return {
        amount: BigInt(view.amount),
        codeHash: String(view.code_hash),
        storageUsage: Number(view.storage_usage),
      };
    } catch (error) {
      if (isMissingAccount(error)) return null;
      throw error;
    }
  }

  return {
    async networkId() {
      return String((await rpc<{ chain_id: string }>("status", [])).chain_id);
    },
    account: (accountId) => accountAt(accountId, null),
    async snapshot(accountId) {
      const final = await rpc<{ header: { height: number } }>("block", { finality: "final" });
      const block = { block_id: final.header.height };
      const snapshot: Snapshot = {
        blockHeight: final.header.height,
        account: await accountAt(accountId, block),
        keys: [],
        config: undefined,
        configError: null,
      };
      if (!snapshot.account) return snapshot;
      const list = await query<{
        keys: { public_key: string; access_key: { permission: unknown } }[];
      }>({ request_type: "view_access_key_list", account_id: accountId }, block);
      snapshot.keys = list.keys.map((k) => ({
        publicKey: String(k.public_key),
        permission: k.access_key.permission,
      }));
      try {
        const call = await query<{ result: number[] }>(
          {
            request_type: "call_function",
            account_id: accountId,
            method_name: "get_config",
            args_base64: Buffer.from("{}").toString("base64"),
          },
          block,
        );
        snapshot.config = JSON.parse(Buffer.from(call.result).toString("utf8"));
      } catch (error) {
        snapshot.configError = error instanceof Error ? error.message : String(error);
      }
      return snapshot;
    },
    async storagePricePerByte() {
      const config = await rpc<{ runtime_config: { storage_amount_per_byte: string } }>(
        "EXPERIMENTAL_protocol_config",
        { finality: "final" },
      );
      return BigInt(config.runtime_config.storage_amount_per_byte);
    },
  };
}

export function toNearAction(action: PlannedAction): Action {
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
        // The verify that follows reads the final block: wait until the batch is in it.
        waitUntil: "FINAL",
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`${file} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} does not hold a JSON object`);
  }
  const credentials = parsed as Record<string, unknown>;
  if (credentials.account_id !== undefined && credentials.account_id !== accountId) {
    throw new UsageError(`${file} is for ${String(credentials.account_id)}, not ${accountId}`);
  }
  return keyPair(credentials.private_key ?? credentials.secret_key, file);
}
