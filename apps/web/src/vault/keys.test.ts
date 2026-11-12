import { describe, expect, it } from "vitest";
import { decodeSegwitAddress, type Vault } from "@morrow/core-ts/browser";
import {
  generateKeys,
  generateRecoveryKey,
  handOffKeys,
  handedOffKeys,
  keyFileName,
  keyFileText,
  keyMismatch,
  parseKeyFile,
  type LoadedKeys,
} from "./keys";

const context = {
  nearNetwork: "testnet",
  vaultContract: "vault.testnet",
  ownerAccount: "alice.testnet",
};
const deployment = { nearNetwork: "testnet", contractId: "vault.testnet" };

function loaded(text: string): LoadedKeys {
  const parsed = parseKeyFile(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.keys;
}

describe("vault keys", () => {
  it("draws fresh, distinct Owner, Guardian and watcher keys", () => {
    const a = generateKeys();
    const b = generateKeys();
    expect(a.owner.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(a.guardian.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(a.watcher.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a.owner.publicKey, a.guardian.publicKey, b.owner.publicKey]).size).toBe(3);
  });

  it("draws a signet test Recovery Address with its WIF", () => {
    const key = generateRecoveryKey();
    expect(decodeSegwitAddress(key.address, "signet").ok).toBe(true);
    expect(key.address).toMatch(/^tb1q/);
    expect(key.wif).toMatch(/^c/);
  });

  it("writes the documented key file and reads it back", () => {
    const keys = generateKeys();
    const recovery = generateRecoveryKey();
    const text = keyFileText(keys, { ...context, vaultId: "12" }, recovery);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "kind",
      "version",
      "near_network",
      "vault_contract",
      "btc_network",
      "owner_account",
      "owner_secret_hex",
      "guardian_secret_hex",
      "watcher_x25519_sk_hex",
      "recovery_secret_wif",
      "vault_id",
    ]);
    expect(body).toMatchObject({
      kind: "morrow-vault-keys",
      version: 1,
      near_network: "testnet",
      vault_contract: "vault.testnet",
      btc_network: "signet",
      owner_account: "alice.testnet",
      recovery_secret_wif: recovery.wif,
      vault_id: "12",
    });
    const back = loaded(text);
    expect(back.owner.publicKey).toBe(keys.owner.publicKey);
    expect(back.guardian.publicKey).toBe(keys.guardian.publicKey);
    expect(back.watcher.publicKey).toBe(keys.watcher.publicKey);
    expect(back.recovery).toEqual(recovery);
    expect(back.vaultId).toBe("12");
    // Before the Vault exists, and without a test Recovery Address: neither field.
    const bare = JSON.parse(keyFileText(keys, context, null)) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("vault_id");
    expect(bare).not.toHaveProperty("recovery_secret_wif");
    expect(keyFileName(null)).toBe("morrow-vault-keys.json");
    expect(keyFileName("12")).toBe("morrow-vault-12-keys.json");
  });

  it("refuses files that are not key files, or carry a bad key, without echoing a secret", () => {
    const text = keyFileText(generateKeys(), context, null);
    const body = JSON.parse(text) as Record<string, unknown>;
    const variant = (patch: Record<string, unknown>) => JSON.stringify({ ...body, ...patch });
    expect(parseKeyFile("not json")).toEqual({ ok: false, problem: "format" });
    expect(parseKeyFile(variant({ kind: "other" }))).toEqual({ ok: false, problem: "format" });
    expect(parseKeyFile(variant({ version: 2 }))).toEqual({ ok: false, problem: "format" });
    expect(parseKeyFile(variant({ btc_network: "bitcoin" }))).toEqual({
      ok: false,
      problem: "format",
    });
    expect(parseKeyFile(variant({ owner_secret_hex: "00".repeat(32) }))).toEqual({
      ok: false,
      problem: "key",
    });
    expect(parseKeyFile(variant({ guardian_secret_hex: "zz" }))).toEqual({
      ok: false,
      problem: "key",
    });
    expect(parseKeyFile(variant({ recovery_secret_wif: "nope" }))).toEqual({
      ok: false,
      problem: "key",
    });
  });

  it("refuses keys for another network, Vault, account or key set", () => {
    const keys = generateKeys();
    const file = loaded(keyFileText(keys, { ...context, vaultId: "12" }, null));
    const vault: Pick<Vault, "vault_id" | "owner_account" | "owner_key" | "policy"> = {
      vault_id: "12",
      owner_account: "alice.testnet",
      owner_key: keys.owner.publicKey,
      policy: {
        btc_network: "signet",
        guardians: [
          {
            guardian_key: keys.guardian.publicKey,
            guardian_account: "alice.testnet",
            kind: "backup_device",
          },
        ],
      } as Vault["policy"],
    };
    expect(keyMismatch(file, deployment, vault)).toBeNull();
    expect(keyMismatch(file, { ...deployment, nearNetwork: "mainnet" }, vault)).toBe("network");
    expect(keyMismatch(file, { ...deployment, contractId: "other.testnet" }, vault)).toBe(
      "network",
    );
    expect(
      keyMismatch(file, deployment, {
        ...vault,
        policy: { ...vault.policy, btc_network: "regtest" },
      }),
    ).toBe("network");
    expect(keyMismatch(file, deployment, { ...vault, vault_id: "13" })).toBe("vault");
    expect(
      keyMismatch({ ...file, vaultId: null }, deployment, { ...vault, vault_id: "13" }),
    ).toBeNull();
    expect(keyMismatch(file, deployment, { ...vault, owner_account: "bob.testnet" })).toBe(
      "account",
    );
    const other = generateKeys();
    expect(keyMismatch(file, deployment, { ...vault, owner_key: other.owner.publicKey })).toBe(
      "owner-key",
    );
    expect(
      keyMismatch(file, deployment, {
        ...vault,
        policy: {
          ...vault.policy,
          guardians: [
            {
              guardian_key: other.guardian.publicKey,
              guardian_account: "g",
              kind: "backup_device",
            },
          ],
        },
      }),
    ).toBe("guardian-key");
  });

  it("hands keys to the new Vault's page in memory, for that Vault only", () => {
    const keys = loaded(keyFileText(generateKeys(), context, null));
    handOffKeys("21", keys);
    expect(handedOffKeys("21")).toBe(keys);
    expect(handedOffKeys("22")).toBeNull();
  });
});
