import type { MorrowEvent } from "./events.js";
import type {
  BeginClawbackArgs,
  CreateVaultArgs,
  Hex,
  ProposePolicyChangeArgs,
  RefreshArgs,
  RequestWithdrawalArgs,
  SpendAllowanceArgs,
  SpendOp,
  U64,
  Vault,
  VaultKit,
} from "./types.js";

/**
 * The Vault Contract's public surface. One method per contract method or view; the contract
 * method name is in each comment. Rejections throw `MorrowContractError` with an `ERR_*` code.
 */
export interface ContractClient {
  /** `create_vault` (payable). Caller becomes the Owner. Returns the vault id. */
  createVault(args: CreateVaultArgs): Promise<U64>;
  /** `top_up_storage` (payable). Anyone. */
  topUpStorage(vaultId: U64, depositYocto: string): Promise<void>;

  /** `request_withdrawal`. Owner, envelope required. Returns the op id. */
  requestWithdrawal(args: RequestWithdrawalArgs): Promise<U64>;
  /** `begin_execute`. Owner, envelope required, only once `executable_at` has passed. */
  beginExecute(opId: U64, envelope: Hex): Promise<SpendOp>;
  /** `spend_allowance`. Owner, envelope required; goes straight to frozen. */
  spendAllowance(args: SpendAllowanceArgs): Promise<SpendOp>;
  /** `refresh`. Owner, envelope required; the only output is the Vault Address. */
  refresh(args: RefreshArgs): Promise<SpendOp>;
  /** `propose_policy_change`. Owner, envelope required. Returns the change id. */
  proposePolicyChange(args: ProposePolicyChangeArgs): Promise<U64>;

  /** `cancel`. Owner (envelope required) or any Guardian; pending withdrawals only. */
  cancel(opId: U64, envelope?: Hex): Promise<void>;
  /** `begin_clawback`. Any Guardian. Returns the clawback op id. */
  beginClawback(args: BeginClawbackArgs): Promise<U64>;
  /** `sign_input`. Owner for withdrawal/allowance/refresh ops, Guardian for clawback ops. */
  signInput(opId: U64, inputIndex: number): Promise<Hex>;
  /** `veto_policy_change`. Any Guardian, or the Owner withdrawing their own change (envelope required). */
  vetoPolicyChange(changeId: U64, envelope?: Hex): Promise<void>;
  /** `fast_approve`. Trusted Contact Guardians only, when the Policy enables Fast Approval. */
  fastApprove(opId: U64): Promise<void>;
  /** `apply_policy_change`. Anyone, once `effective_at` has passed. */
  applyPolicyChange(changeId: U64): Promise<void>;

  /** `get_vault`. */
  getVault(vaultId: U64): Promise<Vault>;
  /** `get_op`. */
  getOp(opId: U64): Promise<SpendOp>;
  /** `get_vault_kit`. Only for active (or clawed back) Vaults. */
  getVaultKit(vaultId: U64): Promise<VaultKit>;
  /** `events_since`. Events with `seq > cursor`, ascending, at most `limit` (≤ 100). */
  eventsSince(cursor: U64, limit: number): Promise<MorrowEvent[]>;
}

/** Contract method names, for clients that call the contract over RPC. */
export const CONTRACT_METHODS = {
  createVault: "create_vault",
  topUpStorage: "top_up_storage",
  requestWithdrawal: "request_withdrawal",
  beginExecute: "begin_execute",
  spendAllowance: "spend_allowance",
  refresh: "refresh",
  proposePolicyChange: "propose_policy_change",
  cancel: "cancel",
  beginClawback: "begin_clawback",
  signInput: "sign_input",
  vetoPolicyChange: "veto_policy_change",
  fastApprove: "fast_approve",
  applyPolicyChange: "apply_policy_change",
  getVault: "get_vault",
  getOp: "get_op",
  getVaultKit: "get_vault_kit",
  eventsSince: "events_since",
} as const satisfies Record<keyof ContractClient, string>;

export const EVENTS_SINCE_MAX_LIMIT = 100;

/** `executable` is derived, never stored: a pending withdrawal whose `executable_at` has passed. */
export function isExecutable(op: SpendOp, nowNs: bigint): boolean {
  return (
    op.kind === "withdrawal" &&
    op.state === "pending" &&
    op.executable_at !== null &&
    nowNs >= BigInt(op.executable_at)
  );
}
