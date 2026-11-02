import type {
  AccountId,
  ContractClient,
  MorrowEvent,
  Policy,
  PolicyChangeFields,
  U64,
} from "@morrow/core-ts";
import type { ClawbackJob, ClawbackTrigger } from "../clawback/jobs.js";
import type { EventHandler, HandlerContext } from "../loop.js";

export interface ChallengeHandlerOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** Client signed by the Guardian account, for `veto_policy_change`. */
  signer: ContractClient;
  /** `MORROW_CHALLENGE_OWNER_PARENT`: Owner Accounts directly under it are Challenge Vaults. */
  ownerParent: AccountId;
  /** Queues a Clawback due now; the runner does the rest and retries its own steps. */
  enqueue(vaultId: U64, trigger: ClawbackTrigger): Promise<ClawbackJob>;
}

/** Consecutive failed vetoes of one change before the handler logs an error and moves on. */
export const MAX_VETO_ATTEMPTS = 10;

/** True when the Policy already holds every value the change proposed. */
function showsApplied(policy: Policy, changes: PolicyChangeFields): boolean {
  const entries = Object.entries(changes);
  return (
    entries.length > 0 && entries.every(([field, value]) => policy[field as keyof Policy] === value)
  );
}

/** True for `<label>.<parent>`: only the parent's holder can create such an account. */
export function isChallengeOwner(owner: AccountId, parent: AccountId): boolean {
  const suffix = `.${parent}`;
  if (!owner.endsWith(suffix)) return false;
  const label = owner.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

/**
 * Challenge mode (FR-27): on a Challenge Vault every Withdrawal Request is clawed back and every
 * Policy Change is vetoed. Other Vaults are ignored. A throw retries the event on the next tick.
 */
export class ChallengeHandler implements EventHandler {
  readonly name = "challenge";
  /** The Owner Account never changes, so one lookup per Vault is enough. */
  private readonly owners = new Map<U64, AccountId>();
  /** Consecutive veto failures per change id; a veto that never lands must not stall the loop. */
  private readonly vetoFailures = new Map<U64, number>();

  constructor(private readonly options: ChallengeHandlerOptions) {}

  async handle(event: MorrowEvent, { log }: HandlerContext): Promise<void> {
    if (event.kind === "vault_created") {
      this.owners.set(event.vault_id, event.data.owner_account);
      return;
    }
    if (event.kind !== "withdrawal_requested" && event.kind !== "policy_change_proposed") return;
    if (!isChallengeOwner(await this.ownerOf(event.vault_id), this.options.ownerParent)) return;

    if (event.kind === "withdrawal_requested") {
      const job = await this.options.enqueue(event.vault_id, "challenge");
      log("info", "challenge: clawback queued for withdrawal request", {
        vault_id: event.vault_id,
        op_id: event.data.op_id,
        job_id: job.job_id,
      });
      return;
    }

    const changeId = event.data.change_id;
    try {
      await this.options.signer.vetoPolicyChange(changeId);
      this.vetoFailures.delete(changeId);
      log("info", "challenge: policy change vetoed", {
        vault_id: event.vault_id,
        change_id: changeId,
      });
    } catch (error) {
      const failures = (this.vetoFailures.get(changeId) ?? 0) + 1;
      this.vetoFailures.set(changeId, failures);
      // Nothing left to veto when the change is no longer pending or the Vault is no longer
      // active (a Policy Change cannot apply to a clawed-back Vault). Anything else retries.
      const vault = await this.options.reader.getVault(event.vault_id);
      const fields = { vault_id: event.vault_id, change_id: changeId, vault_state: vault.state };
      if (vault.state === "active" && vault.pending_change?.change_id === changeId) {
        if (failures < MAX_VETO_ATTEMPTS) throw error;
        this.vetoFailures.delete(changeId);
        log("error", `challenge: veto failed ${failures} times; giving up on this change`, {
          ...fields,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      this.vetoFailures.delete(changeId);
      if (showsApplied(vault.policy, event.data.changes)) {
        log("error", "challenge: policy change applied before veto", fields);
      } else {
        log("info", "challenge: policy change already settled", fields);
      }
    }
  }

  private async ownerOf(vaultId: U64): Promise<AccountId> {
    let owner = this.owners.get(vaultId);
    if (owner === undefined) {
      owner = (await this.options.reader.getVault(vaultId)).owner_account;
      this.owners.set(vaultId, owner);
    }
    return owner;
  }
}
