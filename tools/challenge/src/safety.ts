import type { Policy } from "@morrow/core-ts";

/** The Policy property that would let an attacker skip the Delay, named in `UNSAFE_POLICY`. */
export type UnsafeField =
  | "allowance_limit_sats"
  | "guardians"
  | "trusted_contact"
  | "fast_approval"
  | "auto_clawback"
  | "btc_network"
  | "recovery_address";

/** What a round's Policy must point at: the watcher's Guardian and the Recovery Wallet. */
export interface RoundExpectations {
  guardianAccount: string;
  guardianKey: string;
  recoveryAddress: string;
}

/**
 * Fields `MORROW_CHALLENGE_POLICY` may never set: they decide who can claw back, where the coins
 * go and whose keys sign. Owner fields are not Policy fields at all.
 */
export const LOCKED_OVERRIDE_FIELDS = [
  "recovery_address",
  "guardians",
  "watcher_x25519_pk",
  "btc_network",
  "owner_key",
  "owner_account",
] as const;

/** The first locked field present in the overrides, or null. */
export function checkPolicyOverrides(overrides: object): string | null {
  return LOCKED_OVERRIDE_FIELDS.find((field) => Object.hasOwn(overrides, field)) ?? null;
}

/**
 * Round safety: every path that skips the Delay must be closed before the keys are published.
 * Returns the first unsafe field, or null when the Policy is safe for a Challenge Vault.
 */
export function checkRoundPolicy(policy: Policy, expected: RoundExpectations): UnsafeField | null {
  if (policy.allowance_limit_sats !== "0") return "allowance_limit_sats";
  const guardians: unknown = policy.guardians;
  if (!Array.isArray(guardians) || guardians.some((g) => !g || typeof g !== "object")) {
    return "guardians";
  }
  if (policy.guardians.some((g) => g.kind === "trusted_contact")) return "trusted_contact";
  if (policy.fast_approval !== false) return "fast_approval";
  const watcher = policy.guardians.some(
    (g) =>
      g.kind === "auto_clawback" &&
      g.guardian_account === expected.guardianAccount &&
      g.guardian_key === expected.guardianKey,
  );
  if (!watcher) return "auto_clawback";
  if (policy.btc_network !== "signet") return "btc_network";
  if (policy.recovery_address !== expected.recoveryAddress) return "recovery_address";
  return null;
}
