/** Every error the Vault Contract can raise, with the message UIs show (Glossary wording). */
export const ERROR_CODES = {
  ERR_UNAUTHORIZED: "This account is not allowed to do that on this Vault.",
  ERR_VAULT_NOT_FOUND: "No Vault exists with this id.",
  ERR_VAULT_NOT_ACTIVE: "The Vault is not active yet: its Co-signer keys are still being derived.",
  ERR_OP_NOT_FOUND: "No operation exists with this id.",
  ERR_BAD_OP_STATE: "The operation is not in a state that allows this action.",
  ERR_BAD_ENVELOPE: "The Watcher Envelope must be exactly 80 bytes.",
  ERR_NOT_EXECUTABLE: "The Delay has not passed yet. The Withdrawal Request is still pending.",
  ERR_OUTPOINT_RESERVED: "One of these coins is already used by another operation.",
  ERR_TOO_MANY_INPUTS: "An operation can spend at most 5 coins.",
  ERR_NO_INPUTS: "An operation must spend at least one coin.",
  ERR_FEE_TOO_HIGH: "The fee would exceed the Vault's Fee Cap.",
  ERR_INSUFFICIENT_FUNDS: "The selected coins do not cover the amount and the fee.",
  ERR_ALLOWANCE_LIMIT:
    "This spend would exceed the Spending Allowance limit for the last 24 hours.",
  ERR_CLAWED_BACK: "The Vault was clawed back to its Recovery Address and is closed.",
  ERR_SCRIPT_BOUND:
    "Guardians, the Escape Timelock and the network are fixed for this Vault. Changing them needs a new Vault.",
  ERR_CHANGE_PENDING: "Another Policy Change is already pending for this Vault.",
  ERR_CHANGE_NOT_FOUND: "No Policy Change exists with this id.",
  ERR_CHANGE_NOT_EFFECTIVE: "The Policy Change Delay has not passed yet.",
  ERR_POLICY_BOUNDS: "A Policy value is outside the allowed bounds.",
  ERR_POLICY_CHANGE_DELAY:
    "The Policy Change Delay must be at least the Delay, and at least 7 days.",
  ERR_GUARDIAN_COUNT: "A Vault needs between 1 and 3 Guardians.",
  ERR_DUPLICATE_GUARDIAN: "Two Guardians share the same key or account.",
  ERR_NETWORK_NOT_ALLOWED: "This deployment does not accept that Bitcoin network.",
  ERR_BAD_ADDRESS: "The Bitcoin address is invalid for this Vault's network.",
  ERR_BAD_KEY: "The public key is not a valid compressed secp256k1 key.",
  ERR_STORAGE_BUDGET: "The Vault's storage balance is too low. Top up storage to continue.",
  ERR_DEPOSIT_TOO_LOW: "The attached deposit is below the minimum Vault storage.",
  ERR_CREATOR_NOT_ALLOWED: "This deployment accepts new Vaults only from its operator.",
  ERR_FAST_APPROVAL_DISABLED: "Fast Approval is not enabled for this Vault.",
  ERR_NOT_TRUSTED_CONTACT: "Only a Guardian of kind Trusted Contact can fast-approve.",
  ERR_INPUT_INDEX: "This input index does not exist in the operation.",
  ERR_SIGNER_FAILED: "The NEAR MPC network did not return a signature. Try signing again.",
  ERR_REFRESH_TOO_SOON: "This Vault was refreshed less than one Delay ago. Try again later.",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CODES, value);
}

export class MorrowContractError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MorrowContractError";
    this.code = code;
  }

  /** The message to show a user. */
  get userMessage(): string {
    return ERROR_CODES[this.code];
  }
}

/** Extracts the first `ERR_*` code from a contract panic or RPC error text, if it is a known code. */
export function parseContractError(text: string): MorrowContractError | null {
  for (const match of text.matchAll(/ERR_[A-Z_]+/g)) {
    if (isErrorCode(match[0])) return new MorrowContractError(match[0]);
  }
  return null;
}
