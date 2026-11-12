import { describe, expect, it } from "vitest";
import { MorrowContractError } from "./errors.js";
import { validatePolicy } from "./policy.js";
import { signetPolicy, type SignetPolicyInputs } from "./signet-policy.js";

const inputs: SignetPolicyInputs = {
  delay: "1h",
  recoveryAddress: " tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7 ",
  guardianKey: `02${"11".repeat(32)}`,
  guardianAccount: "alice.testnet",
  watcherX25519Pk: "33".repeat(32),
};

describe("signetPolicy", () => {
  it("builds the signet Policy and it passes validatePolicy", () => {
    const policy = signetPolicy(inputs);
    expect(policy).toEqual({
      delay_ns: "3600000000000",
      policy_change_delay_ns: "604800000000000",
      escape_timelock_blocks: 4320,
      recovery_address: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
      allowance_limit_sats: "10000",
      fee_cap_sats: "100000",
      fast_approval: false,
      fast_approval_floor_ns: "600000000000",
      guardians: [
        {
          guardian_key: `02${"11".repeat(32)}`,
          guardian_account: "alice.testnet",
          kind: "backup_device",
        },
      ],
      btc_network: "signet",
      watcher_x25519_pk: "33".repeat(32),
    });
    expect(() => validatePolicy(policy, ["signet"])).not.toThrow();
  });

  it("uses the 24 h Delay when asked", () => {
    const policy = signetPolicy({ ...inputs, delay: "24h" });
    expect(policy.delay_ns).toBe("86400000000000");
    expect(() => validatePolicy(policy, ["regtest", "signet"])).not.toThrow();
  });

  it("is refused by validatePolicy on a bad Recovery Address or another network", () => {
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return error instanceof MorrowContractError ? error.code : "other";
      }
      return null;
    };
    const bad = signetPolicy({ ...inputs, recoveryAddress: "bc1qnotsignet" });
    expect(code(() => validatePolicy(bad, ["signet"]))).toBe("ERR_BAD_ADDRESS");
    expect(code(() => validatePolicy(signetPolicy(inputs), ["regtest"]))).toBe(
      "ERR_NETWORK_NOT_ALLOWED",
    );
  });
});
