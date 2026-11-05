import { x25519 } from "@noble/curves/ed25519.js";
import {
  MINUTE_NS,
  bytesToHex,
  hexToBytes,
  looseningReasons,
  openEnvelope,
  type AccountId,
  type ContractClient,
  type EnvelopeKeypair,
  type Hex,
  type MorrowEvent,
  type Vault,
} from "@morrow/core-ts";
import { isChallengeOwner } from "../challenge/handler.js";
import type { EventHandler, HandlerContext } from "../loop.js";
import { noConfirmation, type GuardDuress, type GuardEntry, type GuardStore } from "./store.js";

/** The guard vetoes a still-pending change this long before its `effective_at` (AD-21). */
export const VETO_LEAD_NS = 65n * MINUTE_NS;

/** The keypair behind `MORROW_WATCHER_X25519_SK`; the public key is derived, never configured. */
export function envelopeKeypair(secretKeyHex: Hex): EnvelopeKeypair {
  const secret = hexToBytes(secretKeyHex);
  return { publicKeyHex: bytesToHex(x25519.getPublicKey(secret)), secretKeyHex };
}

/**
 * The envelope's flag, or `unknown` when there is no key, the key is not the Vault's
 * `watcher_x25519_pk`, or the envelope does not open.
 */
export async function readDuress(
  envelope: Hex,
  vaultWatcherPk: Hex,
  keypair: EnvelopeKeypair | null,
): Promise<GuardDuress> {
  if (!keypair || keypair.publicKeyHex !== vaultWatcherPk.toLowerCase()) return "unknown";
  try {
    return await openEnvelope(envelope, keypair);
  } catch {
    return "unknown";
  }
}

export function isGuarded(vault: Vault, guardianAccount: AccountId): boolean {
  return vault.policy.guardians.some(
    (g) => g.guardian_account === guardianAccount && g.kind === "auto_clawback",
  );
}

export interface LooseningGuardOptions {
  /** Unsigned client for views. */
  reader: ContractClient;
  /** The configured Auto-Clawback Guardian; only Vaults that list it as such are guarded. */
  guardianAccount: AccountId;
  store: GuardStore;
  /** From `MORROW_WATCHER_X25519_SK`; without it every duress flag reads `unknown`. */
  envelopeKeypair: EnvelopeKeypair | null;
  /** Challenge mode's parent account: its Vaults are left to the challenge handler. */
  challengeOwnerParent: AccountId | null;
}

/**
 * Loosening guard: schedules a veto from `effective_at − 65 min` on for every loosening or
 * duress-flagged Policy Change on a guarded Vault. `GuardTicker` sends the vetoes, for as long as
 * the change is pending, and the Owner Confirmation requests (5.3b); a loosening change escapes
 * the veto only when the Owner confirmed it from the active owner chat and it is not
 * duress-flagged. Without an active owner link every loosening change is vetoed (fail-closed).
 */
export class LooseningGuard implements EventHandler {
  readonly name = "loosening_guard";

  constructor(private readonly options: LooseningGuardOptions) {}

  async handle(event: MorrowEvent, { log }: HandlerContext): Promise<void> {
    if (event.kind === "policy_change_proposed") return this.schedule(event, log);
    if (
      event.kind !== "policy_change_vetoed" &&
      event.kind !== "policy_change_withdrawn" &&
      event.kind !== "policy_change_applied"
    ) {
      return;
    }
    const { store, reader, guardianAccount } = this.options;
    const entry = await store.entry(event.data.change_id);
    if (!entry) return;
    const fields = { vault_id: entry.vault_id, change_id: entry.change_id };
    if (entry.status !== "scheduled") {
      // Logged for every recorded entry alike, so the log never tells a scheduled one apart.
      log("info", "loosening guard: change closed", fields);
      return;
    }
    let next: Pick<GuardEntry, "status" | "cause">;
    if (event.kind === "policy_change_vetoed" && event.data.by === guardianAccount) {
      // A Clawback vetoes the pending change as the clawing Guardian: not the guard's veto.
      const clawedBack = (await reader.getVault(entry.vault_id)).state === "clawed_back";
      next = clawedBack
        ? { status: "settled", cause: "clawback" }
        : { status: "vetoed", cause: null };
    } else if (event.kind === "policy_change_vetoed") {
      next = { status: "settled", cause: "vetoed" };
    } else if (event.kind === "policy_change_withdrawn") {
      next = { status: "settled", cause: "withdrawn" };
    } else {
      next = { status: "settled", cause: "applied" };
    }
    if (!(await store.update({ ...entry, ...next }, "scheduled"))) return;
    if (event.kind === "policy_change_applied") {
      log("error", "loosening guard: loosening change applied without a veto", fields);
    } else {
      log("info", "loosening guard: change closed", fields);
    }
  }

  private async schedule(
    event: Extract<MorrowEvent, { kind: "policy_change_proposed" }>,
    log: HandlerContext["log"],
  ): Promise<void> {
    const { reader, store, guardianAccount, envelopeKeypair, challengeOwnerParent } = this.options;
    const { change_id, changes, effective_at, envelope } = event.data;
    if (await store.entry(change_id)) return;
    const vault = await reader.getVault(event.vault_id);
    if (!isGuarded(vault, guardianAccount)) return;
    const fields = { vault_id: vault.vault_id, change_id };

    const reasons = looseningReasons(vault.policy, changes);
    const loosening = reasons.length > 0;
    if (envelopeKeypair && envelopeKeypair.publicKeyHex !== vault.policy.watcher_x25519_pk) {
      log(
        "warn",
        "loosening guard: MORROW_WATCHER_X25519_SK is not this Vault's watcher key",
        fields,
      );
    }
    const duress = await readDuress(envelope, vault.policy.watcher_x25519_pk, envelopeKeypair);
    const effectiveAt = BigInt(effective_at);
    const vetoAt = effectiveAt > VETO_LEAD_NS ? effectiveAt - VETO_LEAD_NS : 0n;

    let decision: Pick<GuardEntry, "status" | "cause">;
    if (vault.owner_account === guardianAccount) {
      // Its veto would be an Owner withdrawal, which needs an envelope: it would fail every tick.
      log(
        "error",
        "loosening guard: config error, the Owner Account is the guard's Guardian account",
        fields,
      );
      decision = { status: "skipped", cause: "owner is the guardian account" };
    } else if (
      challengeOwnerParent !== null &&
      isChallengeOwner(vault.owner_account, challengeOwnerParent)
    ) {
      decision = { status: "skipped", cause: "challenge vault" };
    } else if ((await reader.getPolicyChange(change_id)).state !== "pending") {
      // Replaying history (first start, or a rebuilt store): nothing left to veto or report.
      decision = { status: "settled", cause: "already settled at first sight" };
    } else if (loosening || duress === "duress") {
      decision = { status: "scheduled", cause: null };
    } else {
      decision = { status: "skipped", cause: "not loosening" };
    }
    await store.add({
      change_id,
      vault_id: event.vault_id,
      proposed_at: event.block_timestamp,
      effective_at,
      veto_at: vetoAt.toString(),
      loosening,
      reasons,
      duress,
      ...decision,
      ...noConfirmation(),
      last_error: null,
    });
    // One neutral line for every entry: no status, reasons or flags, so a duress-flagged change
    // (scheduled even when it tightens) cannot be told apart in the log.
    log("info", "loosening guard: change recorded", fields);
  }
}
