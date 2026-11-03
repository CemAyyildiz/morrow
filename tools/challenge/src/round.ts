import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MIN_VAULT_STORAGE_YOCTO,
  MorrowContractError,
  bytesToHex,
  presetPolicy,
  validatePolicy,
  type AccountId,
  type BitcoinBackend,
  type ContractClient,
  type Hex,
  type Policy,
  type Vault,
} from "@morrow/core-ts";
import { KeyPair } from "near-api-js";
import { RecoveryWalletError, type RecoveryWallet } from "./recovery-wallet.js";
import { checkPolicyOverrides, checkRoundPolicy, type RoundExpectations } from "./safety.js";
import {
  rotationDeadline,
  type NearNetwork,
  type RoundRecord,
  type RoundStep,
  type RoundStore,
} from "./store.js";

export type RoundErrorCode =
  "UNSAFE_POLICY" | "INVALID_POLICY" | "ROUND_OPEN" | "RECOVERY_BALANCE_SHORT" | "STEP_FAILED";

export class RoundError extends Error {
  constructor(
    readonly code: RoundErrorCode,
    detail: string,
    readonly step: RoundStep | null = null,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RoundError";
  }
}

/** The NEAR side of a round, done by the operator. */
export interface RoundNear {
  /** Creates `accountId` under the parent, with `publicKey` as its only (full-access) key. */
  createOwnerAccount(accountId: AccountId, publicKey: string): Promise<void>;
  /** A Vault Contract client signed by the Owner Account's full-access key. */
  ownerClient(accountId: AccountId, secretKey: string): ContractClient;
  /** Adds the published key: function calls to the Vault Contract only, 1 NEAR gas allowance. */
  addFunctionCallKey(accountId: AccountId, secretKey: string, publicKey: string): Promise<void>;
}

export interface RoundPolicyInputs {
  guardianAccount: AccountId;
  /** 33-byte compressed key of the watcher's Auto-Clawback Guardian. */
  guardianKey: Hex;
  watcherX25519Pk: Hex;
  recoveryAddress: string;
  fundSats: bigint;
  /** Optional operator overrides; locked fields and anything unsafe are refused. */
  overrides?: Partial<Policy>;
}

/**
 * Fee Cap of every round: the lowest the bounds allow. The published key can freeze a Refresh
 * once per Delay, so this caps what it can burn to miners at min(10,000 sats, 5 %) per Delay.
 */
export const ROUND_FEE_CAP_SATS = "10000";

/**
 * The Standard signet preset with allowance 0, the lowest Fee Cap and the watcher as the only
 * Guardian. Throws
 * `UNSAFE_POLICY` when the overrides touch a locked field (Guardians, Recovery Address, …).
 */
export function buildRoundPolicy(inputs: RoundPolicyInputs): Policy {
  const locked = checkPolicyOverrides(inputs.overrides ?? {});
  if (locked) throw new RoundError("UNSAFE_POLICY", locked);
  return {
    ...presetPolicy("standard", {
      plannedDepositSats: inputs.fundSats,
      guardians: [
        {
          guardian_key: inputs.guardianKey,
          guardian_account: inputs.guardianAccount,
          kind: "auto_clawback",
        },
      ],
      recoveryAddress: inputs.recoveryAddress,
      network: "signet",
      watcherX25519Pk: inputs.watcherX25519Pk,
    }),
    allowance_limit_sats: "0",
    fast_approval: false,
    fee_cap_sats: ROUND_FEE_CAP_SATS,
    ...inputs.overrides,
  };
}

/** The expectations a round's Policy is checked against. */
export function roundExpectations(inputs: RoundPolicyInputs): RoundExpectations {
  return {
    guardianAccount: inputs.guardianAccount,
    guardianKey: inputs.guardianKey,
    recoveryAddress: inputs.recoveryAddress,
  };
}

/** Refuses an unsafe or invalid Policy before anything is created. */
export function assertRoundPolicy(policy: Policy, expected: RoundExpectations): void {
  const unsafe = checkRoundPolicy(policy, expected);
  if (unsafe) throw new RoundError("UNSAFE_POLICY", unsafe);
  try {
    validatePolicy(policy, ["signet"]);
  } catch (error) {
    if (error instanceof MorrowContractError) throw new RoundError("INVALID_POLICY", error.message);
    throw error;
  }
}

export interface OpenRoundOptions {
  store: RoundStore;
  near: RoundNear;
  wallet: Pick<RecoveryWallet, "address" | "plan" | "prepare" | "broadcast">;
  /** `MORROW_CHALLENGE_OWNER_PARENT`; round N's Owner Account is `r<N>.<parent>`. */
  ownerParent: AccountId;
  vaultContract: AccountId;
  nearNetwork: NearNetwork;
  policy: Omit<RoundPolicyInputs, "recoveryAddress">;
  /** Open round N+1 even though a round is still open (it is closed once N+1 is open). */
  next?: boolean;
  /** Waits for `pending_keys` → `active` (the MPC derivations). */
  activationTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  progress?: (message: string) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Opens one round: checks the Policy, the open rounds and the Recovery balance, then creates the
 * Owner Account, the Vault and the published function-call key, and funds the Vault Address. The
 * round is persisted after every step, so a failure leaves a record of what exists.
 */
export async function openRound(options: OpenRoundOptions): Promise<RoundRecord> {
  const { store, near, wallet } = options;
  const progress = options.progress ?? (() => undefined);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fundSats = options.policy.fundSats;

  const inputs = { ...options.policy, recoveryAddress: wallet.address };
  const policy = buildRoundPolicy(inputs);
  assertRoundPolicy(policy, roundExpectations(inputs));

  const rounds = await store.rounds();
  const unclosed = rounds.filter((r) => r.status !== "closed");
  if (unclosed.length > 0 && !options.next) {
    const latest = unclosed.at(-1) as RoundRecord;
    const detail =
      latest.status === "open"
        ? `round ${latest.round} is open`
        : `round ${latest.round} is incomplete (failed at ${latest.failed_step ?? "unknown"})`;
    throw new RoundError("ROUND_OPEN", `${detail}; use --next to open a new round`);
  }

  try {
    await wallet.plan(fundSats);
  } catch (error) {
    if (error instanceof RecoveryWalletError && error.code === "RECOVERY_BALANCE_SHORT") {
      throw new RoundError("RECOVERY_BALANCE_SHORT", error.detail);
    }
    throw error;
  }

  const number = Math.max(0, ...rounds.map((r) => r.round)) + 1;
  const accountKey = KeyPair.fromRandom("ed25519");
  const functionCallKey = KeyPair.fromRandom("ed25519");
  const ownerSecret = secp256k1.utils.randomSecretKey();
  const now = new Date().toISOString();
  const round: RoundRecord = {
    round: number,
    status: "opening",
    vault_contract: options.vaultContract,
    near_network: options.nearNetwork,
    btc_network: policy.btc_network,
    failed_step: null,
    last_error: null,
    owner_account: `r${number}.${options.ownerParent}`,
    owner_account_full_access_key: accountKey.toString(),
    owner_key: bytesToHex(secp256k1.getPublicKey(ownerSecret, true)),
    owner_key_secret: bytesToHex(ownerSecret),
    near_function_call_key: functionCallKey.toString(),
    near_function_call_public_key: functionCallKey.getPublicKey().toString(),
    function_call_key_added: false,
    vault_id: null,
    vault_address: null,
    allowance_address: null,
    escape_timelock_blocks: policy.escape_timelock_blocks,
    fund_sats: fundSats.toString(),
    funding_txid: null,
    funding_height: null,
    rotation_deadline_height: null,
    opened_at: now,
    updated_at: now,
  };

  // Recorded before the account exists: if the account lands but the call throws, its key is
  // kept and the next round moves on to r<N+1>.
  await store.put(round);

  let step: RoundStep = "account";
  const fail = async (error: unknown): Promise<never> => {
    round.failed_step = step;
    round.last_error = message(error);
    await store.put(round).catch(() => undefined);
    throw new RoundError("STEP_FAILED", `${step}: ${message(error)}`, step);
  };

  try {
    progress(`round ${number}: creating ${round.owner_account}`);
    await near.createOwnerAccount(round.owner_account, accountKey.getPublicKey().toString());

    step = "vault";
    const owner = near.ownerClient(round.owner_account, round.owner_account_full_access_key);
    round.vault_id = await owner.createVault({
      owner_key: round.owner_key,
      policy,
      deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    });
    await store.put(round);
    const vault = await waitActive(owner, round.vault_id, options.activationTimeoutMs, sleep);
    if (!vault.addresses) throw new Error(`Vault ${round.vault_id} has no addresses`);
    round.vault_address = vault.addresses.vault;
    round.allowance_address = vault.addresses.allowance;
    await store.put(round);
    progress(`round ${number}: Vault ${round.vault_id} active at ${round.vault_address}`);

    step = "function_call_key";
    await near.addFunctionCallKey(
      round.owner_account,
      round.owner_account_full_access_key,
      round.near_function_call_public_key,
    );
    round.function_call_key_added = true;
    await store.put(round);

    step = "funding";
    // The txid is recorded before the broadcast, so a retry can never fund twice unnoticed.
    const signed = await wallet.prepare(vault.addresses.vault, vault.addresses, fundSats);
    round.funding_txid = signed.txid;
    await store.put(round);
    await wallet.broadcast(signed);
    round.status = "open";
    round.failed_step = null;
    round.last_error = null;
    // Only now does the new round replace the one being served.
    await store.put(round, { closeOthers: true });
    progress(`round ${number}: funded ${fundSats} sats in ${round.funding_txid}`);
  } catch (error) {
    return fail(error);
  }
  return round;
}

async function waitActive(
  client: ContractClient,
  vaultId: string,
  timeoutMs = 120_000,
  sleep: (ms: number) => Promise<void>,
): Promise<Vault> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const vault = await client.getVault(vaultId);
    if (vault.state === "active") return vault;
    if (vault.state !== "pending_keys") throw new Error(`Vault ${vaultId} is ${vault.state}`);
    if (Date.now() >= deadline) throw new Error(`Vault ${vaultId} still pending_keys`);
    await sleep(2_000);
  }
}

/**
 * Sets the funding height and the rotation deadline once the funding transaction confirms.
 * Returns the current round (updated or not), or null when no round is open.
 */
export async function refreshDeadline(
  store: RoundStore,
  backend: Pick<BitcoinBackend, "getTx">,
): Promise<RoundRecord | null> {
  const round = await store.current();
  if (!round || !round.funding_txid || round.funding_height !== null) return round;
  const status = await backend.getTx(round.funding_txid);
  if (status?.block_height === null || status?.block_height === undefined) return round;
  const patched = await store.patchFunding(
    round.round,
    status.block_height,
    rotationDeadline(status.block_height, round.escape_timelock_blocks),
  );
  return patched ?? store.current();
}
