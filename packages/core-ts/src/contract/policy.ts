import { MorrowContractError } from "./errors.js";
import type { BtcNetwork, Guardian, Policy, PolicyChangeFields } from "./types.js";

export const MINUTE_NS = 60_000_000_000n;
export const HOUR_NS = 60n * MINUTE_NS;
export const DAY_NS = 24n * HOUR_NS;

/** CSV relative block heights cannot exceed 16 bits. */
export const CSV_MAX_BLOCKS = 65_535;
export const MAX_GUARDIANS = 3;
export const MAX_INPUTS_PER_OP = 5;
export const ENVELOPE_HEX_LENGTH = 160;

export type PresetName = "standard" | "high_security" | "fortress";

export interface Preset {
  delay_ns: bigint;
  policy_change_delay_ns: bigint;
  escape_timelock_blocks: number;
  /** Suggested Spending Allowance, in basis points of the planned deposit. */
  allowance_bps: number;
  fee_cap_sats: bigint;
}

export const PRESETS: Record<PresetName, Preset> = {
  standard: {
    delay_ns: 24n * HOUR_NS,
    policy_change_delay_ns: 7n * DAY_NS,
    escape_timelock_blocks: 26_280,
    allowance_bps: 100,
    fee_cap_sats: 100_000n,
  },
  high_security: {
    delay_ns: 72n * HOUR_NS,
    policy_change_delay_ns: 14n * DAY_NS,
    escape_timelock_blocks: 39_420,
    allowance_bps: 50,
    fee_cap_sats: 100_000n,
  },
  fortress: {
    delay_ns: 7n * DAY_NS,
    policy_change_delay_ns: 30n * DAY_NS,
    escape_timelock_blocks: 52_560,
    allowance_bps: 25,
    fee_cap_sats: 100_000n,
  },
};

export const DEFAULT_FAST_APPROVAL_FLOOR_NS = 10n * MINUTE_NS;

export interface Bounds {
  delay_ns: [bigint, bigint];
  /** The effective minimum is also max(delay, policy_change_delay_floor_ns). */
  policy_change_delay_ns: [bigint, bigint];
  policy_change_delay_floor_ns: bigint;
  escape_timelock_blocks: [number, number];
  fee_cap_sats: [bigint, bigint];
  /** The effective maximum is the Delay. */
  fast_approval_floor_min_ns: bigint;
}

const STANDARD_BOUNDS: Bounds = {
  delay_ns: [HOUR_NS, 30n * DAY_NS],
  policy_change_delay_ns: [7n * DAY_NS, 90n * DAY_NS],
  policy_change_delay_floor_ns: 7n * DAY_NS,
  escape_timelock_blocks: [4_320, CSV_MAX_BLOCKS],
  fee_cap_sats: [10_000n, 1_000_000n],
  fast_approval_floor_min_ns: 10n * MINUTE_NS,
};

/** Judge Mode: lower bounds drop on regtest only. */
const REGTEST_BOUNDS: Bounds = {
  ...STANDARD_BOUNDS,
  delay_ns: [MINUTE_NS, 30n * DAY_NS],
  policy_change_delay_ns: [MINUTE_NS, 90n * DAY_NS],
  policy_change_delay_floor_ns: MINUTE_NS,
  escape_timelock_blocks: [6, CSV_MAX_BLOCKS],
  fast_approval_floor_min_ns: MINUTE_NS,
};

export function boundsFor(network: BtcNetwork): Bounds {
  return network === "regtest" ? REGTEST_BOUNDS : STANDARD_BOUNDS;
}

/** Fields a Policy Change may touch. Any other field is Script-bound. */
export const CHANGEABLE_FIELDS = [
  "delay_ns",
  "recovery_address",
  "allowance_limit_sats",
  "fee_cap_sats",
  "policy_change_delay_ns",
  "fast_approval",
  "fast_approval_floor_ns",
] as const satisfies readonly (keyof PolicyChangeFields)[];

const BECH32_PREFIX: Record<BtcNetwork, string> = {
  regtest: "bcrt1",
  signet: "tb1",
  testnet4: "tb1",
  bitcoin: "bc1",
};

const fail = (code: ConstructorParameters<typeof MorrowContractError>[0], detail?: string) => {
  throw new MorrowContractError(code, detail);
};

const isU64 = (value: string) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) < 2n ** 64n;
const isCompressedKey = (hex: string) => /^0[23][0-9a-f]{64}$/.test(hex);

export function assertU64(value: string, field: string): bigint {
  if (!isU64(value)) fail("ERR_POLICY_BOUNDS", `${field} is not a u64 decimal string`);
  return BigInt(value);
}

function inRange<T extends bigint | number>(value: T, [min, max]: [T, T]) {
  return value >= min && value <= max;
}

/**
 * Shape check for a SegWit address on the Vault's network. The contract additionally verifies the
 * bech32 checksum; this check exists so the mock and the UI reject obvious mistakes early.
 */
export function isPlausibleAddress(address: string, network: BtcNetwork): boolean {
  const prefix = BECH32_PREFIX[network];
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) return false;
  if (!lower.startsWith(prefix)) return false;
  // "bc1"/"tb1" must not match a regtest address and vice versa.
  if (network !== "regtest" && lower.startsWith("bcrt1")) return false;
  return /^[02-9ac-hj-np-z]{8,87}$/.test(lower.slice(prefix.length));
}

export function assertAddress(address: string, network: BtcNetwork): void {
  if (!isPlausibleAddress(address, network)) fail("ERR_BAD_ADDRESS", address);
}

function validateGuardians(guardians: Guardian[]): void {
  if (guardians.length < 1 || guardians.length > MAX_GUARDIANS) fail("ERR_GUARDIAN_COUNT");
  for (const guardian of guardians) {
    if (!isCompressedKey(guardian.guardian_key)) fail("ERR_BAD_KEY", guardian.guardian_key);
  }
  const keys = new Set(guardians.map((g) => g.guardian_key));
  const accounts = new Set(guardians.map((g) => g.guardian_account));
  if (keys.size !== guardians.length || accounts.size !== guardians.length) {
    fail("ERR_DUPLICATE_GUARDIAN");
  }
}

/** Validates the time-, fee- and address-related fields shared by creation and Policy Changes. */
function validateAdjustable(policy: Policy): void {
  const bounds = boundsFor(policy.btc_network);
  const delay = assertU64(policy.delay_ns, "delay_ns");
  const changeDelay = assertU64(policy.policy_change_delay_ns, "policy_change_delay_ns");
  const feeCap = assertU64(policy.fee_cap_sats, "fee_cap_sats");
  const floor = assertU64(policy.fast_approval_floor_ns, "fast_approval_floor_ns");
  assertU64(policy.allowance_limit_sats, "allowance_limit_sats");

  if (!inRange(delay, bounds.delay_ns)) fail("ERR_POLICY_BOUNDS", "delay_ns");
  if (!inRange(changeDelay, bounds.policy_change_delay_ns)) {
    fail("ERR_POLICY_BOUNDS", "policy_change_delay_ns");
  }
  if (changeDelay < delay || changeDelay < bounds.policy_change_delay_floor_ns) {
    fail("ERR_POLICY_CHANGE_DELAY");
  }
  if (!inRange(feeCap, bounds.fee_cap_sats)) fail("ERR_POLICY_BOUNDS", "fee_cap_sats");
  if (floor < bounds.fast_approval_floor_min_ns || floor > delay) {
    fail("ERR_POLICY_BOUNDS", "fast_approval_floor_ns");
  }
  assertAddress(policy.recovery_address, policy.btc_network);
}

/** Full validation at `create_vault`. */
export function validatePolicy(policy: Policy, allowedNetworks: readonly BtcNetwork[]): void {
  if (!allowedNetworks.includes(policy.btc_network)) fail("ERR_NETWORK_NOT_ALLOWED");
  const bounds = boundsFor(policy.btc_network);
  if (
    !Number.isInteger(policy.escape_timelock_blocks) ||
    !inRange(policy.escape_timelock_blocks, bounds.escape_timelock_blocks)
  ) {
    fail("ERR_POLICY_BOUNDS", "escape_timelock_blocks");
  }
  if (!/^[0-9a-f]{64}$/.test(policy.watcher_x25519_pk)) fail("ERR_BAD_KEY", "watcher_x25519_pk");
  validateGuardians(policy.guardians);
  validateAdjustable(policy);
}

/**
 * Validates a proposed Policy Change against the current Policy and returns the Policy it would
 * produce. Any field outside the whitelist is Script-bound and rejected.
 */
export function validatePolicyChange(current: Policy, changes: object): Policy {
  const keys = Object.keys(changes);
  if (keys.length === 0) fail("ERR_POLICY_BOUNDS", "empty change");
  for (const key of keys) {
    if (!(CHANGEABLE_FIELDS as readonly string[]).includes(key)) fail("ERR_SCRIPT_BOUND", key);
  }
  // Value types as the contract parses them: u64 fields are canonical decimal strings.
  for (const [key, value] of Object.entries(changes)) {
    const ok =
      key === "fast_approval"
        ? typeof value === "boolean"
        : key === "recovery_address"
          ? typeof value === "string"
          : typeof value === "string" && isU64(value);
    if (!ok) fail("ERR_POLICY_BOUNDS", `${key} has the wrong type or format`);
  }
  const next = { ...current, ...(changes as PolicyChangeFields) } as Policy;
  validateAdjustable(next);
  return next;
}

export interface PresetInputs {
  plannedDepositSats: bigint;
  guardians: Guardian[];
  recoveryAddress: string;
  network: BtcNetwork;
  watcherX25519Pk: string;
}

/** Fills every Policy field from a preset; the suggested allowance is computed from the planned deposit. */
export function presetPolicy(name: PresetName, inputs: PresetInputs): Policy {
  const preset = PRESETS[name];
  return {
    delay_ns: preset.delay_ns.toString(),
    policy_change_delay_ns: preset.policy_change_delay_ns.toString(),
    escape_timelock_blocks: preset.escape_timelock_blocks,
    recovery_address: inputs.recoveryAddress,
    allowance_limit_sats: (
      (inputs.plannedDepositSats * BigInt(preset.allowance_bps)) /
      10_000n
    ).toString(),
    fee_cap_sats: preset.fee_cap_sats.toString(),
    fast_approval: false,
    fast_approval_floor_ns: DEFAULT_FAST_APPROVAL_FLOOR_NS.toString(),
    guardians: inputs.guardians,
    btc_network: inputs.network,
    watcher_x25519_pk: inputs.watcherX25519Pk,
  };
}
