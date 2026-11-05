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
import type { GuardDuress, GuardStore } from "./store.js";

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
 * Loosening guard, 5.3a (fail-closed): schedules a veto at `effective_at − 65 min` for every
 * loosening or duress-flagged Policy Change on a guarded Vault. There is no Owner Confirmation
 * yet (5.3b), so no loosening change escapes the veto. `GuardTicker` sends the vetoes.
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
    const { store, guardianAccount } = this.options;
    const entry = await store.entry(event.data.change_id);
    if (!entry || entry.status !== "scheduled") return;
    const ours = event.kind === "policy_change_vetoed" && event.data.by === guardianAccount;
    entry.status = ours ? "vetoed" : "settled";
    await store.update(entry);
    const fields = { vault_id: entry.vault_id, change_id: entry.change_id, event: event.kind };
    if (event.kind === "policy_change_applied") {
      log("error", "loosening guard: change applied before its veto", fields);
    } else {
      log("info", "loosening guard: change settled before its veto", fields);
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

    const challenge =
      challengeOwnerParent !== null && isChallengeOwner(vault.owner_account, challengeOwnerParent);
    const reasons = looseningReasons(vault.policy, changes);
    const loosening = reasons.length > 0;
    if (envelopeKeypair && envelopeKeypair.publicKeyHex !== vault.policy.watcher_x25519_pk) {
      log("warn", "loosening guard: MORROW_WATCHER_X25519_SK is not this Vault's watcher key", {
        vault_id: vault.vault_id,
        change_id,
      });
    }
    const duress = await readDuress(envelope, vault.policy.watcher_x25519_pk, envelopeKeypair);
    const effectiveAt = BigInt(effective_at);
    const vetoAt = effectiveAt > VETO_LEAD_NS ? effectiveAt - VETO_LEAD_NS : 0n;
    const veto = !challenge && (loosening || duress === "duress");
    const entry = await store.add({
      change_id,
      vault_id: event.vault_id,
      proposed_at: event.block_timestamp,
      effective_at,
      veto_at: vetoAt.toString(),
      loosening,
      reasons,
      duress,
      status: veto ? "scheduled" : "skipped",
      last_error: null,
    });
    // The duress flag itself is kept in the store only, never logged.
    log("info", veto ? "loosening guard: veto scheduled" : "loosening guard: nothing to veto", {
      vault_id: entry.vault_id,
      change_id,
      loosening,
      reasons,
      veto_at: entry.veto_at,
      effective_at,
      ...(challenge ? { skipped: "challenge vault" } : {}),
    });
  }
}
