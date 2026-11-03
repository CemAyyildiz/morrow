// What the stub challenge feed serves (e2e only): one published round and its Attempt Log,
// shared by stub-services.ts and challenge.spec.ts so the spec can check the exact values.
// The round's function-call key and the Vault's watcher key are real (deterministic) keys, so
// the browser signs and seals for real and the stub RPC verifies the signatures.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bitcoin-alphabet base58, as NEAR writes keys and hashes. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The raw public key of a curve25519-family private key given by its 32-byte seed. */
function rawPublicKey(seed: Buffer, pkcs8Prefix: string): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from(pkcs8Prefix, "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(String(jwk.x), "base64url");
}

export interface FunctionCallKey {
  /** `ed25519:<base58 seed ‖ public key>`, as `/round` publishes it. */
  secret: string;
  /** `ed25519:<base58 public key>`. */
  publicKey: string;
}

/** A deterministic ed25519 function-call key for `label`. */
export function functionCallKey(label: string): FunctionCallKey {
  const seed = createHash("sha256").update(`morrow-e2e-key:${label}`).digest();
  const pub = rawPublicKey(seed, "302e020100300506032b657004220420");
  return {
    secret: `ed25519:${base58(Buffer.concat([seed, pub]))}`,
    publicKey: `ed25519:${base58(pub)}`,
  };
}

/** The Vault's watcher X25519 public key (hex), as `get_vault` serves it. */
export const WATCHER_X25519_PK = rawPublicKey(
  createHash("sha256").update("morrow-e2e-watcher").digest(),
  "302e020100300506032b656e04220420",
).toString("hex");

/** The published round's function-call key. */
export const ROUND_KEY = functionCallKey("round");

export const ROUND_NUMBER = 3;
export const VAULT_ID = "42";
export const OWNER_ACCOUNT = "r3.challenge.testnet";
export const VAULT_ADDRESS = "tb1qchallengevaultaddressstub0000000000000000";
export const CLAWBACK_TXID = "c1".repeat(32);
export const REQUEST_TX_HASH = "9pRequestHash1111111111111111111111111111111";
export const EARLY_TX_HASH = "9pEarlyExecuteHash22222222222222222222222222";
export const TIP_HEIGHT = 291_600;
export const DEADLINE_HEIGHT = 291_744;
export const VAULT_SATS = 1_000_000;
export const DELAY_NS = "86400000000000";
export const SIGNER = { threshold: 11, total: 16 };

/** `GET /round`: the 7.1a `publicRound` fields. */
export const ROUND = {
  round: ROUND_NUMBER,
  vault_contract: "vault.morrow.testnet",
  near_network: "testnet",
  btc_network: "signet",
  vault_id: VAULT_ID,
  owner_account: OWNER_ACCOUNT,
  owner_key: `02${"5a".repeat(32)}`,
  owner_key_secret: "6b".repeat(32),
  near_function_call_key: ROUND_KEY.secret,
  vault_address: VAULT_ADDRESS,
  escape_timelock_blocks: 1000,
  funding_txid: "f0".repeat(32),
  funding_height: 290_944,
  rotation_deadline_height: DEADLINE_HEIGHT,
};

const HOUR = 3_600_000;
const ns = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

/**
 * The Attempt Log at `now`: a withdrawal clawed back in 41 s (broadcast, with its NEAR hash),
 * an early execute refused with `ERR_NOT_EXECUTABLE`, and a pending request made 6 h ago whose
 * hash is not known yet (its row links the Owner Account).
 */
export function attemptsAt(now: number) {
  const entries = [
    {
      type: "withdrawal",
      round: ROUND_NUMBER,
      n: 3,
      seq: "30",
      vault_id: VAULT_ID,
      op_id: "12",
      amount_sats: "50000",
      destination: "tb1qthief",
      requested_at: ns(now - 6 * HOUR),
      executable_at: ns(now + 18 * HOUR),
      time: new Date(now - 6 * HOUR).toISOString(),
      outcome: "pending",
      outcome_at: null,
      outcome_time: null,
      clawback_op_id: null,
      clawback_txid: null,
      clawback_broadcast: false,
      tx_hash: null,
    },
    {
      type: "rejected",
      round: ROUND_NUMBER,
      n: 2,
      tx_hash: EARLY_TX_HASH,
      block_timestamp: ns(now - 7 * HOUR),
      time: new Date(now - 7 * HOUR).toISOString(),
      method: "begin_execute",
      code: "ERR_NOT_EXECUTABLE",
      failure: "ActionError.FunctionCallError.ExecutionError",
    },
    {
      type: "key_rotated",
      round: ROUND_NUMBER,
      time: new Date(now - 7.5 * HOUR).toISOString(),
      reason: "allowance_low",
      old_public_key: "ed25519:old",
      new_public_key: "ed25519:new",
    },
    {
      type: "withdrawal",
      round: ROUND_NUMBER,
      n: 1,
      seq: "20",
      vault_id: VAULT_ID,
      op_id: "10",
      amount_sats: "90000",
      destination: "tb1qthief",
      requested_at: ns(now - 8 * HOUR),
      executable_at: ns(now + 16 * HOUR),
      time: new Date(now - 8 * HOUR).toISOString(),
      outcome: "clawed_back",
      outcome_at: ns(now - 8 * HOUR + 41_000),
      outcome_time: new Date(now - 8 * HOUR + 41_000).toISOString(),
      clawback_op_id: "11",
      clawback_txid: CLAWBACK_TXID,
      clawback_broadcast: true,
      tx_hash: REQUEST_TX_HASH,
    },
  ];
  return {
    entries,
    summary: {
      round: ROUND_NUMBER,
      attempts_round: 3,
      attempts_total: 3,
      sats_taken_total: 0,
      last_attempt_at: new Date(now - 6 * HOUR).toISOString(),
    },
  };
}
