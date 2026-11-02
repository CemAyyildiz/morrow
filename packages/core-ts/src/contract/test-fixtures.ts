import { MockContractClient, MIN_VAULT_STORAGE_YOCTO } from "./mock.js";
import { presetPolicy } from "./policy.js";
import type { Guardian, Outpoint, Policy } from "./types.js";

export const OWNER = "owner.test.near";
export const EMMA = "emma.test.near";
export const BACKUP = "backup.test.near";
export const STRANGER = "stranger.test.near";
export const OWNER_KEY = `02${"11".repeat(32)}`;
export const ENVELOPE = "ab".repeat(80);
export const RECOVERY = `tb1qrcvry${"q".repeat(33)}`;
export const DESTINATION = `tb1qdstn${"p".repeat(34)}`;

export const GUARDIANS: Guardian[] = [
  { guardian_key: `03${"22".repeat(32)}`, guardian_account: EMMA, kind: "trusted_contact" },
  { guardian_key: `02${"33".repeat(32)}`, guardian_account: BACKUP, kind: "backup_device" },
];

export function signetPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...presetPolicy("standard", {
      plannedDepositSats: 10_000_000n,
      guardians: GUARDIANS,
      recoveryAddress: RECOVERY,
      network: "signet",
      watcherX25519Pk: "44".repeat(32),
    }),
    ...overrides,
  };
}

export function utxo(n: number, valueSats = 1_000_000): Outpoint {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, value_sats: valueSats.toString() };
}

export async function setup(overrides: Partial<Policy> = {}) {
  const mock = new MockContractClient().asCaller(OWNER);
  const vaultId = await mock.createVault({
    owner_key: OWNER_KEY,
    policy: signetPolicy(overrides),
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
  });
  return { mock, vaultId };
}
