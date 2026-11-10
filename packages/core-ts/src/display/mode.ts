import { ERROR_CODES, MorrowContractError, type ErrorCode } from "../contract/errors.js";
import type { PolicyChangeState, SpendOpState, VaultState } from "../contract/types.js";

/**
 * The single render path's one switch (FR-13): a Duress Session renders the same screens as a
 * normal one. Duress mode only remaps what would tell a coercer the Vault fought back: Voided and
 * Cancelled requests, a ClawedBack Vault and vetoed Policy Changes all show as Pending, and
 * `ERR_CLAWED_BACK` on Execute shows as the generic network-busy message.
 */
export type DisplayMode = "normal" | "duress";

const PENDING = "Pending";

/** Labels of a request's stored state in normal mode. Only a Clawback voids a request. */
export const OP_STATE_LABELS: Readonly<Record<SpendOpState, string>> = {
  pending: PENDING,
  frozen: "Executing",
  signed: "Signed",
  cancelled: "Cancelled",
  voided: "Clawed back",
};

export const VAULT_STATE_LABELS: Readonly<Record<VaultState, string>> = {
  pending_keys: "Pending keys",
  active: "Active",
  clawed_back: "Clawed back",
};

export const CHANGE_STATE_LABELS: Readonly<Record<PolicyChangeState, string>> = {
  pending: PENDING,
  applied: "Applied",
  vetoed: "Vetoed",
  withdrawn: "Withdrawn",
};

/** What a Duress Session shows when Execute meets a clawed-back Vault. */
export const NETWORK_BUSY = "Network busy, try again later.";

const DURESS_OP_STATES: ReadonlySet<SpendOpState> = new Set(["voided", "cancelled"]);

/** Errors on Execute that a Duress Session shows as `NETWORK_BUSY`: a Clawback causes both. */
const DURESS_EXECUTE_ERRORS: ReadonlySet<ErrorCode> = new Set([
  "ERR_CLAWED_BACK",
  "ERR_BAD_OP_STATE",
]);

/** A request's state label; an unknown state shows as itself. */
export function opStateLabel(state: SpendOpState, mode: DisplayMode): string {
  if (mode === "duress" && DURESS_OP_STATES.has(state)) return PENDING;
  return OP_STATE_LABELS[state] ?? String(state);
}

/** A Vault's state label. A Duress Session shows a ClawedBack Vault as an active one. */
export function vaultStateLabel(state: VaultState, mode: DisplayMode): string {
  const shown = mode === "duress" && state === "clawed_back" ? "active" : state;
  return VAULT_STATE_LABELS[shown] ?? String(shown);
}

/** A Policy Change's state label; an unknown state shows as itself. */
export function changeStateLabel(state: PolicyChangeState, mode: DisplayMode): string {
  if (mode === "duress" && state === "vetoed") return PENDING;
  return CHANGE_STATE_LABELS[state] ?? String(state);
}

/**
 * The message for a failed Execute: the contract error's meaning, except that a Duress Session
 * shows `NETWORK_BUSY` for `ERR_CLAWED_BACK` and `ERR_BAD_OP_STATE` (Execute on a voided or
 * cancelled request). Errors that are not contract errors keep their own message, and an unknown
 * code shows as itself.
 */
export function executeErrorMessage(error: unknown, mode: DisplayMode): string {
  if (error instanceof MorrowContractError) {
    if (mode === "duress" && DURESS_EXECUTE_ERRORS.has(error.code)) return NETWORK_BUSY;
    return ERROR_CODES[error.code] ?? String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}
