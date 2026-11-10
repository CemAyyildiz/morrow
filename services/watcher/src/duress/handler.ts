import type {
  AccountId,
  ContractClient,
  EnvelopeKeypair,
  Hex,
  MorrowEvent,
  U64,
  Vault,
} from "@morrow/core-ts";
import { isChallengeOwner } from "../challenge/handler.js";
import type { JobStore } from "../clawback/jobs.js";
import { VETO_LEAD_NS, isGuarded, readDuress } from "../guard/handler.js";
import type { EventHandler, HandlerContext } from "../loop.js";
import type { DuressStore, DuressVault } from "./store.js";

export interface DuressHandlerOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** The configured Auto-Clawback Guardian; only Vaults that list it as such are watched. */
  guardianAccount: AccountId;
  store: DuressStore;
  /** The Clawback queue the runner works from. */
  jobs: JobStore;
  /** From `MORROW_WATCHER_X25519_SK`; the handler only runs with it. */
  envelopeKeypair: EnvelopeKeypair;
  /** Challenge mode's parent account: its Vaults are left to the challenge handler. */
  challengeOwnerParent: AccountId | null;
}

/** The Owner's Watcher Envelope an event carries, or null. */
export function ownerEnvelope(event: MorrowEvent): Hex | null {
  switch (event.kind) {
    case "withdrawal_requested":
    case "policy_change_proposed":
    case "policy_change_withdrawn":
    case "op_frozen":
      return event.data.envelope;
    default:
      return null;
  }
}

/**
 * When a Vault in duress must be clawed back: `min(min live executable_at, first_duress_signal_at +
 * delay_ns) − 65 min`, or `now` once that has passed. `live` holds the `executable_at` of the
 * recorded withdrawals that are still pending.
 */
export function duressDueAt(
  firstDuressSignalAt: bigint,
  delayNs: bigint,
  live: readonly bigint[],
  now: bigint,
): bigint {
  const deadline = live.reduce((min, at) => (at < min ? at : min), firstDuressSignalAt + delayNs);
  const due = deadline > VETO_LEAD_NS ? deadline - VETO_LEAD_NS : 0n;
  return due > now ? due : now;
}

/**
 * Duress scheduling (FR-13, AD-9): reads the duress flag of every Owner Watcher Envelope on a
 * guarded Vault and, from the first duress signal on, keeps a `duress` Clawback job queued early
 * enough to beat every pending withdrawal and the Delay since the signal. The job and the handler's
 * state are persisted before `handle` returns, so the loop commits the event only after both.
 *
 * An unreadable flag (`unknown`) never schedules anything: a Clawback moves every coin, so a false
 * positive is costly. The log is the same for a duress and a normal envelope.
 */
export class DuressHandler implements EventHandler {
  readonly name = "duress_handler";

  constructor(private readonly options: DuressHandlerOptions) {}

  async handle(event: MorrowEvent, { clock, log }: HandlerContext): Promise<void> {
    const envelope = ownerEnvelope(event);
    if (envelope === null && event.kind !== "fast_approved") return;
    const { reader, store, guardianAccount, envelopeKeypair, challengeOwnerParent } = this.options;
    const vault = await reader.getVault(event.vault_id);
    if (!isGuarded(vault, guardianAccount)) return;
    if (vault.owner_account === guardianAccount) return;
    if (
      challengeOwnerParent !== null &&
      isChallengeOwner(vault.owner_account, challengeOwnerParent)
    ) {
      return;
    }
    const fields = { vault_id: vault.vault_id, seq: event.seq, kind: event.kind };

    if (event.kind === "withdrawal_requested" || event.kind === "fast_approved") {
      await store.recordOp(vault.vault_id, event.data.op_id);
    }

    let signal = false;
    if (envelope !== null) {
      const duress = await readDuress(envelope, vault.policy.watcher_x25519_pk, envelopeKeypair);
      if (duress === "unknown") {
        log(
          "warn",
          "duress handler: envelope could not be read; no Clawback scheduled from it",
          fields,
        );
      } else {
        if (duress === "duress") {
          await store.markDuress(vault.vault_id, event.block_timestamp);
          signal = true;
        }
        // The same line for a duress and a normal envelope.
        log("info", "duress handler: envelope recorded", fields);
      }
    }

    const state = await store.vault(vault.vault_id);
    if (!state || state.first_duress_signal_at === null) return;
    // A duress signal (first or not, so a retried event still queues), or a withdrawal or a Fast
    // Approval that can move the deadline earlier.
    if (!signal && event.kind !== "withdrawal_requested" && event.kind !== "fast_approved") return;
    await this.schedule(vault, state, await clock.now());
  }

  /** Queues the Vault's `duress` job, or moves its open queued job earlier. */
  private async schedule(vault: Vault, state: DuressVault, now: bigint): Promise<void> {
    // A clawed-back Vault (seen when replaying history) has nothing left to claw.
    if (vault.state === "clawed_back") return;
    const { reader, jobs } = this.options;
    const live: bigint[] = [];
    for (const opId of state.ops) {
      const op = await reader.getOp(opId);
      if (op.state === "pending" && op.executable_at !== null) live.push(BigInt(op.executable_at));
    }
    const dueAt = duressDueAt(
      BigInt(state.first_duress_signal_at as U64),
      BigInt(vault.policy.delay_ns),
      live,
      now,
    ).toString();
    const job = await jobs.enqueue(vault.vault_id, "duress", dueAt);
    if (job.status === "queued" && BigInt(dueAt) < BigInt(job.due_at)) {
      await jobs.advance(vault.vault_id, dueAt);
    }
  }
}
