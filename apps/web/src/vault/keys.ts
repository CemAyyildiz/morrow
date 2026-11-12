// The Bitcoin keys of a web-created Vault: drawn in the browser, saved by the user as a key
// file, and loaded back from it on the Vault page. They live in memory only: nothing here
// writes them to storage, sends them anywhere or logs them.
import {
  bytesToHex,
  compressedPublicKey,
  decodeWif,
  encodeWif,
  hexToBytes,
  p2wpkhAddress,
  randomSecretKey,
  randomX25519SecretKey,
  x25519PublicKey,
  type Vault,
} from "@morrow/core-ts/browser";

export const KEY_FILE_KIND = "morrow-vault-keys";

/** A key pair: the secret in memory, the public key as the contract stores it. */
export interface KeyPair {
  secret: Uint8Array;
  publicKey: string;
}

/** A test Recovery Address the browser drew, with its WIF so its coins can be spent. */
export interface RecoveryKey {
  wif: string;
  address: string;
}

export interface VaultKeys {
  /** The Owner Key: Withdrawal and Escape Paths. */
  owner: KeyPair;
  /** The Backup Device Guardian Key: the Clawback Path. */
  guardian: KeyPair;
  /** The X25519 key the Vault's Watcher Envelopes are sealed to. */
  watcher: KeyPair;
}

/** Who and where the keys belong to, as the key file records it. */
export interface KeyFileContext {
  nearNetwork: string;
  vaultContract: string;
  ownerAccount: string;
  vaultId?: string | null;
}

/** A loaded key file: the keys plus what it says they belong to. */
export interface LoadedKeys extends VaultKeys {
  nearNetwork: string;
  vaultContract: string;
  btcNetwork: "signet";
  ownerAccount: string;
  vaultId: string | null;
  recovery: RecoveryKey | null;
}

const secp = (secret: Uint8Array): KeyPair => ({ secret, publicKey: compressedPublicKey(secret) });

/** Fresh Owner, Guardian and watcher keys. */
export function generateKeys(): VaultKeys {
  const watcher = randomX25519SecretKey();
  return {
    owner: secp(randomSecretKey()),
    guardian: secp(randomSecretKey()),
    watcher: { secret: watcher, publicKey: x25519PublicKey(watcher) },
  };
}

/** A fresh P2WPKH key on signet, for testing only: its address and WIF. */
export function generateRecoveryKey(): RecoveryKey {
  const secret = randomSecretKey();
  return {
    wif: encodeWif(secret, "signet"),
    address: p2wpkhAddress(compressedPublicKey(secret), "signet"),
  };
}

/** The key file's JSON, field by field in the documented order. */
export function keyFileText(
  keys: VaultKeys,
  context: KeyFileContext,
  recovery: RecoveryKey | null,
): string {
  const body: Record<string, unknown> = {
    kind: KEY_FILE_KIND,
    version: 1,
    near_network: context.nearNetwork,
    vault_contract: context.vaultContract,
    btc_network: "signet",
    owner_account: context.ownerAccount,
    owner_secret_hex: bytesToHex(keys.owner.secret),
    guardian_secret_hex: bytesToHex(keys.guardian.secret),
    watcher_x25519_sk_hex: bytesToHex(keys.watcher.secret),
  };
  if (recovery !== null) body.recovery_secret_wif = recovery.wif;
  if (context.vaultId) body.vault_id = context.vaultId;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** `morrow-vault-<id>-keys.json`, or `morrow-vault-keys.json` before the Vault exists. */
export function keyFileName(vaultId: string | null | undefined): string {
  return vaultId ? `morrow-vault-${vaultId}-keys.json` : "morrow-vault-keys.json";
}

export type KeyFileProblem =
  /** Not JSON, or not a Morrow Vault key file. */
  | "format"
  /** A key in it is not a valid key. */
  | "key";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHex32 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Reads a key file's text; never echoes a secret back in the problem. */
export function parseKeyFile(
  text: string,
): { ok: true; keys: LoadedKeys } | { ok: false; problem: KeyFileProblem } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, problem: "format" };
  }
  if (!isRecord(body) || body.kind !== KEY_FILE_KIND || body.version !== 1) {
    return { ok: false, problem: "format" };
  }
  const b = body;
  if (!nonEmpty(b.near_network) || !nonEmpty(b.vault_contract) || !nonEmpty(b.owner_account)) {
    return { ok: false, problem: "format" };
  }
  if (b.btc_network !== "signet") return { ok: false, problem: "format" };
  if (b.vault_id !== undefined && !(typeof b.vault_id === "string" && /^\d+$/.test(b.vault_id))) {
    return { ok: false, problem: "format" };
  }
  if (!isHex32(b.owner_secret_hex) || !isHex32(b.guardian_secret_hex)) {
    return { ok: false, problem: "key" };
  }
  if (!isHex32(b.watcher_x25519_sk_hex)) return { ok: false, problem: "key" };
  try {
    const owner = secp(hexToBytes(b.owner_secret_hex));
    const guardian = secp(hexToBytes(b.guardian_secret_hex));
    const watcherSecret = hexToBytes(b.watcher_x25519_sk_hex);
    let recovery: RecoveryKey | null = null;
    if (b.recovery_secret_wif !== undefined) {
      if (typeof b.recovery_secret_wif !== "string") return { ok: false, problem: "key" };
      const secret = decodeWif(b.recovery_secret_wif, "signet");
      recovery = {
        wif: b.recovery_secret_wif,
        address: p2wpkhAddress(compressedPublicKey(secret), "signet"),
      };
    }
    return {
      ok: true,
      keys: {
        owner,
        guardian,
        watcher: { secret: watcherSecret, publicKey: x25519PublicKey(watcherSecret) },
        nearNetwork: b.near_network,
        vaultContract: b.vault_contract,
        btcNetwork: "signet",
        ownerAccount: b.owner_account,
        vaultId: typeof b.vault_id === "string" ? b.vault_id : null,
        recovery,
      },
    };
  } catch {
    return { ok: false, problem: "key" };
  }
}

export type KeyMismatch =
  /** Another NEAR network or Vault Contract. */
  | "network"
  /** A key file for another Vault id. */
  | "vault"
  /** A key file for another Owner Account. */
  | "account"
  /** Its Owner Key is not this Vault's. */
  | "owner-key"
  /** Its Guardian Key is not one of this Vault's Guardians. */
  | "guardian-key";

/**
 * Why loaded keys do not belong to this Vault on this deployment, or null when they do. Keys
 * that do not belong are refused whole: nothing is signed or sent with them.
 */
export function keyMismatch(
  keys: LoadedKeys,
  deployment: { nearNetwork: string; contractId: string },
  vault: Pick<Vault, "vault_id" | "owner_account" | "owner_key" | "policy">,
): KeyMismatch | null {
  if (keys.nearNetwork !== deployment.nearNetwork || keys.vaultContract !== deployment.contractId) {
    return "network";
  }
  if (vault.policy.btc_network !== keys.btcNetwork) return "network";
  if (keys.vaultId !== null && keys.vaultId !== vault.vault_id) return "vault";
  if (keys.ownerAccount !== vault.owner_account) return "account";
  if (keys.owner.publicKey !== vault.owner_key) return "owner-key";
  if (!vault.policy.guardians.some((g) => g.guardian_key === keys.guardian.publicKey)) {
    return "guardian-key";
  }
  return null;
}

/** How long the key file's object URL lives after the click. */
export const REVOKE_AFTER_MS = 60_000;

/** Saves `text` as `filename` from a Blob object URL, revoked a minute after the click. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers cancel a download whose URL is revoked right after the click.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * Keys handed from the create wizard to the new Vault's page within one page load: memory
 * only, replaced by the next hand-off and gone with the page.
 */
let handoff: { vaultId: string; keys: LoadedKeys } | null = null;

export function handOffKeys(vaultId: string, keys: LoadedKeys): void {
  handoff = { vaultId, keys };
}

export function handedOffKeys(vaultId: string): LoadedKeys | null {
  return handoff?.vaultId === vaultId ? handoff.keys : null;
}
