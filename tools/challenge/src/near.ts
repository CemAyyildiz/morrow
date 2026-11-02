import { NearContractClient, type AccountId, type ContractClient } from "@morrow/core-ts";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { AccessKeyDoesNotExistError } from "near-api-js/rpc-errors";
import type { RoundNear } from "./round.js";
import type { KeyState, RunNear } from "./run.js";

const NEAR = 1_000_000_000_000_000_000_000_000n;
/** Covers the 0.5 NEAR Vault storage deposit, account storage and the published key's gas. */
export const ROUND_ACCOUNT_YOCTO = 2n * NEAR;
/** Gas the published key may burn before it is spent (a NEAR allowance error, not a coin risk). */
export const FUNCTION_CALL_ALLOWANCE_YOCTO = NEAR;
/** The published key is replaced when its remaining allowance falls below 0.05 NEAR. */
export const KEY_ALLOWANCE_LOW_YOCTO = NEAR / 20n;
/** Storage is topped up by 0.5 NEAR when the Vault's storage balance falls below 0.2 NEAR. */
export const STORAGE_LOW_YOCTO = NEAR / 5n;
export const STORAGE_TOP_UP_YOCTO = NEAR / 2n;
/** Spam burns the Owner Account's own balance as gas: refill 1 NEAR when below 0.5 NEAR. */
export const OWNER_BALANCE_LOW_YOCTO = NEAR / 2n;
export const OWNER_BALANCE_TOP_UP_YOCTO = NEAR;

/**
 * The published key's permission. A function-call key can only sign calls to `contractId` with no
 * attached deposit: it cannot add keys, transfer NEAR or deploy. Empty `methodNames` means every
 * Vault method.
 */
export function functionCallKeyPermission(contractId: AccountId) {
  return { contractId, methodNames: [] as string[], allowance: FUNCTION_CALL_ALLOWANCE_YOCTO };
}

/** The account actions a round needs; near-api-js `Account` implements them. */
export interface RoundAccount {
  createSubAccount(args: {
    accountOrPrefix: string;
    publicKey: string;
    nearToTransfer: bigint;
  }): Promise<unknown>;
  addFunctionCallAccessKey(args: {
    publicKey: string;
    contractId: string;
    methodNames: string[];
    allowance: bigint;
  }): Promise<unknown>;
  /** View; throws `AccessKeyDoesNotExistError` when the key is gone. */
  getAccessKey(publicKey: string): Promise<{ permission: unknown }>;
  deleteKey(publicKey: string): Promise<unknown>;
  /** View: the account's balance; `available` excludes what storage locks. */
  getState(): Promise<{ balance: { available: bigint } }>;
  transfer(args: { receiverId: string; amount: bigint }): Promise<unknown>;
}

export interface NearRoundOptions {
  rpcUrl: string;
  vaultContract: AccountId;
  ownerParent: AccountId;
  /** Full-access key ("ed25519:…") of the parent account. Never logged. */
  parentKey: string;
  /** Test seam: the account for an id and key. */
  account?: (accountId: AccountId, secretKey: string) => RoundAccount;
  /** Test seam: a Vault Contract client, signed by `signer` when given. */
  contract?: (signer?: { accountId: AccountId; secretKey: string }) => ContractClient;
}

const isMissingKey = (error: unknown) =>
  error instanceof AccessKeyDoesNotExistError ||
  (error instanceof Error && /access key .* does not exist/i.test(error.message));

/** Reads a view's permission: `FullAccess` or `{ FunctionCall: { allowance } }`. */
export function keyState(permission: unknown): KeyState {
  if (typeof permission === "object" && permission !== null && "FunctionCall" in permission) {
    const allowance = (permission as { FunctionCall: { allowance?: unknown } }).FunctionCall
      .allowance;
    return {
      exists: true,
      allowanceYocto:
        allowance === null || allowance === undefined ? null : BigInt(String(allowance)),
    };
  }
  return { exists: true, allowanceYocto: null };
}

/**
 * `RunNear` over NEAR JSON-RPC: the parent creates each Owner Account and pays storage top-ups;
 * the Owner Account's full-access key adds and deletes the published key.
 */
export function nearRound(options: NearRoundOptions): RunNear {
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const account =
    options.account ??
    ((accountId: AccountId, secretKey: string): RoundAccount =>
      new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as never)));
  const contract =
    options.contract ??
    ((signer?: { accountId: AccountId; secretKey: string }): ContractClient =>
      new NearContractClient({
        contractId: options.vaultContract,
        rpcUrl: options.rpcUrl,
        ...(signer ? { signer } : {}),
      }));
  const viewer = contract();
  const near: RoundNear = {
    async createOwnerAccount(accountId, publicKey) {
      await account(options.ownerParent, options.parentKey).createSubAccount({
        accountOrPrefix: accountId,
        publicKey,
        nearToTransfer: ROUND_ACCOUNT_YOCTO,
      });
    },
    ownerClient(accountId, secretKey): ContractClient {
      return contract({ accountId, secretKey });
    },
    async addFunctionCallKey(accountId, secretKey, publicKey) {
      await account(accountId, secretKey).addFunctionCallAccessKey({
        publicKey,
        ...functionCallKeyPermission(options.vaultContract),
      });
    },
  };
  return {
    ...near,
    getVault: (vaultId) => viewer.getVault(vaultId),
    async topUpStorage(vaultId, depositYocto) {
      await contract({
        accountId: options.ownerParent,
        secretKey: options.parentKey,
      }).topUpStorage(vaultId, depositYocto.toString());
    },
    async accessKey(accountId, secretKey, publicKey) {
      try {
        return keyState((await account(accountId, secretKey).getAccessKey(publicKey)).permission);
      } catch (error) {
        if (isMissingKey(error)) return { exists: false };
        throw error;
      }
    },
    async availableBalance(accountId) {
      // A view: the signer is not used.
      return (await account(accountId, options.parentKey).getState()).balance.available;
    },
    async transferFromParent(accountId, yocto) {
      await account(options.ownerParent, options.parentKey).transfer({
        receiverId: accountId,
        amount: yocto,
      });
    },
    async deleteKey(accountId, secretKey, publicKey) {
      await account(accountId, secretKey).deleteKey(publicKey);
    },
  };
}
