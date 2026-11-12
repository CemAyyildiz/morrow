// The Policy of a Vault an end user creates from the web app on Bitcoin signet: the standard
// preset with a test-friendly Delay and the shortest Escape Timelock signet allows, one Backup
// Device Guardian, Fast Approval off. Pure: the caller still checks it with `validatePolicy`.
import { DAY_NS, HOUR_NS, presetPolicy } from "./policy.js";
import type { AccountId, Hex, Policy } from "./types.js";

/** `1h` is for testing; `24h` is the standard preset's Delay. */
export type SignetDelay = "1h" | "24h";

export const SIGNET_DELAYS_NS: Record<SignetDelay, bigint> = {
  "1h": HOUR_NS,
  "24h": 24n * HOUR_NS,
};

export const SIGNET_POLICY = {
  policyChangeDelayNs: 7n * DAY_NS,
  /** The lower bound outside regtest: about 30 days of blocks. */
  escapeTimelockBlocks: 4_320,
  feeCapSats: 100_000n,
  /** The Spending Allowance is the standard preset's share of this planned deposit. */
  plannedDepositSats: 1_000_000n,
} as const;

export interface SignetPolicyInputs {
  delay: SignetDelay;
  recoveryAddress: string;
  /** The Backup Device Guardian's 33-byte compressed key. */
  guardianKey: Hex;
  /** The Backup Device Guardian's NEAR account (the Owner's own, from the web app). */
  guardianAccount: AccountId;
  watcherX25519Pk: Hex;
}

/** Every Policy field of a web-created signet Vault. */
export function signetPolicy(inputs: SignetPolicyInputs): Policy {
  const base = presetPolicy("standard", {
    plannedDepositSats: SIGNET_POLICY.plannedDepositSats,
    guardians: [
      {
        guardian_key: inputs.guardianKey,
        guardian_account: inputs.guardianAccount,
        kind: "backup_device",
      },
    ],
    recoveryAddress: inputs.recoveryAddress.trim(),
    network: "signet",
    watcherX25519Pk: inputs.watcherX25519Pk,
  });
  return {
    ...base,
    delay_ns: SIGNET_DELAYS_NS[inputs.delay].toString(),
    policy_change_delay_ns: SIGNET_POLICY.policyChangeDelayNs.toString(),
    escape_timelock_blocks: SIGNET_POLICY.escapeTimelockBlocks,
    fee_cap_sats: SIGNET_POLICY.feeCapSats.toString(),
    fast_approval: false,
  };
}
