import type { Policy } from "@morrow/core-ts";
import { describe, expect, it } from "vitest";
import { buildRoundPolicy } from "./round.js";
import { LOCKED_OVERRIDE_FIELDS, checkPolicyOverrides, checkRoundPolicy } from "./safety.js";
import { GUARDIAN, GUARDIAN_KEY, X25519 } from "./test-helpers.js";

const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
const EXPECTED = {
  guardianAccount: GUARDIAN,
  guardianKey: GUARDIAN_KEY,
  recoveryAddress: RECOVERY,
};
const inputs = (overrides: Partial<Policy> = {}) => ({
  guardianAccount: GUARDIAN,
  guardianKey: GUARDIAN_KEY,
  watcherX25519Pk: X25519,
  recoveryAddress: RECOVERY,
  fundSats: 100_000n,
  overrides,
});
/** The default round Policy with fields replaced directly (bypassing the override lock). */
const policyWith = (fields: Record<string, unknown> = {}) =>
  ({ ...buildRoundPolicy(inputs()), ...fields }) as Policy;
const watcher = { guardian_key: GUARDIAN_KEY, guardian_account: GUARDIAN, kind: "auto_clawback" };

describe("checkRoundPolicy", () => {
  it("accepts the default round Policy: Standard signet preset, allowance 0, Auto-Clawback watcher", () => {
    const policy = buildRoundPolicy(inputs());
    expect(policy).toMatchObject({
      allowance_limit_sats: "0",
      fast_approval: false,
      btc_network: "signet",
      escape_timelock_blocks: 26_280,
      recovery_address: RECOVERY,
      guardians: [watcher],
      watcher_x25519_pk: X25519,
    });
    expect(checkRoundPolicy(policy, EXPECTED)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["allowance_limit_sats", { allowance_limit_sats: "1000" }],
    ["guardians", { guardians: "watcher" }],
    ["guardians", { guardians: [null] }],
    [
      "trusted_contact",
      {
        guardians: [
          watcher,
          {
            guardian_key: `02${"33".repeat(32)}`,
            guardian_account: "emma.testnet",
            kind: "trusted_contact",
          },
        ],
      },
    ],
    ["fast_approval", { fast_approval: true }],
    ["auto_clawback", { guardians: [{ ...watcher, kind: "backup_device" }] }],
    ["auto_clawback", { guardians: [{ ...watcher, guardian_account: "other.testnet" }] }],
    ["auto_clawback", { guardians: [{ ...watcher, guardian_key: `02${"33".repeat(32)}` }] }],
    ["btc_network", { btc_network: "testnet4" }],
    ["btc_network", { btc_network: "bitcoin" }],
    ["recovery_address", { recovery_address: `tb1qthief${"q".repeat(34)}` }],
  ])("names %s", (field, fields) => {
    expect(checkRoundPolicy(policyWith(fields), EXPECTED)).toBe(field);
  });

  it("reports the first unsafe field", () => {
    expect(
      checkRoundPolicy(policyWith({ allowance_limit_sats: "1", fast_approval: true }), EXPECTED),
    ).toBe("allowance_limit_sats");
  });
});

describe("policy overrides", () => {
  it.each(LOCKED_OVERRIDE_FIELDS)("refuses an override of %s", (field) => {
    expect(checkPolicyOverrides({ [field]: "x" })).toBe(field);
    expect(() => buildRoundPolicy(inputs({ [field]: "x" } as Partial<Policy>))).toThrow(
      `UNSAFE_POLICY: ${field}`,
    );
  });

  it("allows adjustable fields", () => {
    expect(checkPolicyOverrides({ fee_cap_sats: "20000", delay_ns: "1" })).toBeNull();
    expect(buildRoundPolicy(inputs({ fee_cap_sats: "20000" })).fee_cap_sats).toBe("20000");
  });
});
