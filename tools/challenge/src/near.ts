import { NearContractClient, type AccountId, type ContractClient } from "@morrow/core-ts";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { RoundNear } from "./round.js";

const NEAR = 1_000_000_000_000_000_000_000_000n;
/** Covers the 0.5 NEAR Vault storage deposit, account storage and the published key's gas. */
export const ROUND_ACCOUNT_YOCTO = 2n * NEAR;
/** Gas the published key may burn before it is spent (a NEAR allowance error, not a coin risk). */
export const FUNCTION_CALL_ALLOWANCE_YOCTO = NEAR;

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
}

export interface NearRoundOptions {
  rpcUrl: string;
  vaultContract: AccountId;
  ownerParent: AccountId;
  /** Full-access key ("ed25519:…") of the parent account. Never logged. */
  parentKey: string;
  /** Test seam: the account for an id and key. */
  account?: (accountId: AccountId, secretKey: string) => RoundAccount;
}

/** `RoundNear` over NEAR JSON-RPC: the parent creates each Owner Account, which then adds its key. */
export function nearRound(options: NearRoundOptions): RoundNear {
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const account =
    options.account ??
    ((accountId: AccountId, secretKey: string): RoundAccount =>
      new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as never)));
  return {
    async createOwnerAccount(accountId, publicKey) {
      await account(options.ownerParent, options.parentKey).createSubAccount({
        accountOrPrefix: accountId,
        publicKey,
        nearToTransfer: ROUND_ACCOUNT_YOCTO,
      });
    },
    ownerClient(accountId, secretKey): ContractClient {
      return new NearContractClient({
        contractId: options.vaultContract,
        rpcUrl: options.rpcUrl,
        signer: { accountId, secretKey },
      });
    },
    async addFunctionCallKey(accountId, secretKey, publicKey) {
      await account(accountId, secretKey).addFunctionCallAccessKey({
        publicKey,
        ...functionCallKeyPermission(options.vaultContract),
      });
    },
  };
}
