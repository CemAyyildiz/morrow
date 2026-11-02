import { describe, expect, it } from "vitest";
import { MorrowContractError, parseContractError } from "./errors.js";
import {
  DAY_NS,
  HOUR_NS,
  MINUTE_NS,
  isPlausibleAddress,
  validatePolicy,
  validatePolicyChange,
} from "./policy.js";
import { GUARDIANS, signetPolicy } from "./test-fixtures.js";
import type { Guardian } from "./types.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof MorrowContractError ? error.code : String(error);
  }
  return "no error";
};

describe("validatePolicy", () => {
  const networks = ["regtest", "signet", "testnet4"] as const;

  it("accepts every preset value on signet", () => {
    expect(code(() => validatePolicy(signetPolicy(), networks))).toBe("no error");
  });

  it("rejects mainnet unless the deployment allows it", () => {
    const policy = signetPolicy({
      btc_network: "bitcoin",
      recovery_address: `bc1qrcvry${"q".repeat(33)}`,
    });
    expect(code(() => validatePolicy(policy, networks))).toBe("ERR_NETWORK_NOT_ALLOWED");
    expect(code(() => validatePolicy(policy, ["bitcoin"]))).toBe("no error");
  });

  it("enforces the Policy Change Delay floor", () => {
    const policy = signetPolicy({ policy_change_delay_ns: (6n * DAY_NS).toString() });
    expect(code(() => validatePolicy(policy, networks))).toBe("ERR_POLICY_BOUNDS");
    const shorterThanDelay = signetPolicy({
      delay_ns: (10n * DAY_NS).toString(),
      policy_change_delay_ns: (8n * DAY_NS).toString(),
    });
    expect(code(() => validatePolicy(shorterThanDelay, networks))).toBe("ERR_POLICY_CHANGE_DELAY");
  });

  it("lowers bounds on regtest only", () => {
    const fast = {
      delay_ns: MINUTE_NS.toString(),
      policy_change_delay_ns: MINUTE_NS.toString(),
      fast_approval_floor_ns: MINUTE_NS.toString(),
      escape_timelock_blocks: 6,
    };
    const regtest = signetPolicy({
      ...fast,
      btc_network: "regtest",
      recovery_address: `bcrt1qrcvry${"q".repeat(33)}`,
    });
    expect(code(() => validatePolicy(regtest, networks))).toBe("no error");
    expect(code(() => validatePolicy(signetPolicy(fast), networks))).toBe("ERR_POLICY_BOUNDS");
  });

  it("requires 1–3 distinct Guardians", () => {
    expect(code(() => validatePolicy(signetPolicy({ guardians: [] }), networks))).toBe(
      "ERR_GUARDIAN_COUNT",
    );
    const [first, second] = GUARDIANS as [Guardian, Guardian];
    const duplicate = [first, { ...second, guardian_account: first.guardian_account }];
    expect(code(() => validatePolicy(signetPolicy({ guardians: duplicate }), networks))).toBe(
      "ERR_DUPLICATE_GUARDIAN",
    );
  });

  it("rejects an address from another network", () => {
    expect(isPlausibleAddress("bcrt1qxyz2345678qqqq", "signet")).toBe(false);
    expect(
      code(() =>
        validatePolicy(signetPolicy({ recovery_address: "bc1qmainnetqqqqqqqqqqqq" }), networks),
      ),
    ).toBe("ERR_BAD_ADDRESS");
  });
});

describe("validatePolicyChange", () => {
  it("returns the next Policy for whitelisted fields", () => {
    const next = validatePolicyChange(signetPolicy(), { delay_ns: (48n * HOUR_NS).toString() });
    expect(next.delay_ns).toBe((48n * HOUR_NS).toString());
  });

  it("rejects every Script-bound field", () => {
    for (const field of [
      "guardians",
      "escape_timelock_blocks",
      "btc_network",
      "watcher_x25519_pk",
    ]) {
      expect(code(() => validatePolicyChange(signetPolicy(), { [field]: 1 }))).toBe(
        "ERR_SCRIPT_BOUND",
      );
    }
  });
});

describe("parseContractError", () => {
  it("extracts a known code from a panic message", () => {
    const error = parseContractError(
      "Smart contract panicked: ERR_NOT_EXECUTABLE: executable_at 14:02",
    );
    expect(error?.code).toBe("ERR_NOT_EXECUTABLE");
    expect(error?.userMessage).toMatch(/Delay has not passed/);
  });

  it("ignores unknown codes", () => {
    expect(parseContractError("ERR_SOMETHING_NEW")).toBeNull();
  });
});
