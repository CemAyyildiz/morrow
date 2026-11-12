// What the Vault page does: plan a Withdrawal Request or a Clawback from the Vault's confirmed
// coins, and carry a frozen op through to Bitcoin: `sign_input` per input (the NEAR MPC
// Co-signer), the local signature with a key from the key file, assembly without bitcoinjs
// (`assembleSpendHex`) and the broadcast to the Esplora backend (`POST /tx`). Each step goes
// through injected `call`/`view`/`broadcast`, so the flows are tested without a wallet.
import {
  assembleSpendHex,
  decodeSegwitAddress,
  sealWatcherEnvelope,
  txidOf,
  type ErrorCode,
  type Outpoint,
  type SegwitAddressProblem,
  type SpendOp,
  type Vault,
} from "@morrow/core-ts/browser";
import { absoluteTime, nsToMs } from "@/app/challenge";
import { withTimeout } from "@/app/live";
import { copy } from "@/copy";
import type { CallOutcome, ViewAnswer } from "./near";

/** The fee rate of every spend the page starts (signet relays at 1 sat/vB). */
export const FEE_RATE_SAT_VB = 2;
/** The contract spends at most this many coins per op. */
export const MAX_INPUTS = 5;
/** Below this the contract refuses a payment output as dust. */
export const DUST_SATS = 546n;
/** How long the page waits between reads of a state NEAR has not shown yet. */
export const RETRY_MS = 3_000;
/** How many times a read is retried before the page gives up. */
export const READ_ATTEMPTS = 20;

// Planning

/** The coins one op spends: the largest confirmed ones, at most five. */
export function spendableCoins(outpoints: readonly Outpoint[]): Outpoint[] {
  return [...outpoints]
    .sort((a, b) => (BigInt(b.value_sats) > BigInt(a.value_sats) ? 1 : -1))
    .slice(0, MAX_INPUTS)
    .map((o) => ({ txid: o.txid, vout: o.vout, value_sats: o.value_sats }));
}

/**
 * The most a Withdrawal Request of `coins` can ask for: their total minus a fee bound of
 * 2 sat/vB × (60 + 250 × inputs) vB, above the contract's own vsize for a Vault spend, so the
 * request can really execute after the Delay. Zero when the coins cannot pay it.
 */
export function maxWithdrawal(coins: readonly Outpoint[]): bigint {
  const total = coins.reduce((sum, o) => sum + BigInt(o.value_sats), 0n);
  const max = total - BigInt(FEE_RATE_SAT_VB) * BigInt(60 + 250 * coins.length);
  return max > 0n ? max : 0n;
}

export type WithdrawalProblem =
  | { kind: "destination"; problem: SegwitAddressProblem }
  | { kind: "amount" }
  | { kind: "funds" }
  | { kind: "seal" };

export interface WithdrawalArgs {
  vault_id: string;
  amount_sats: string;
  destination: string;
  fee_rate_sat_vb: number;
  utxos: Outpoint[];
  envelope: string;
}

/** A Withdrawal Request's arguments, or what is wrong with the form. */
export function planWithdrawal(
  vault: Pick<Vault, "vault_id" | "policy">,
  outpoints: readonly Outpoint[],
  destination: string,
  amountText: string,
): { ok: true; args: WithdrawalArgs } | { ok: false; problem: WithdrawalProblem } {
  const coins = spendableCoins(outpoints);
  const max = maxWithdrawal(coins);
  if (max < DUST_SATS) return { ok: false, problem: { kind: "funds" } };
  const decoded = decodeSegwitAddress(destination.trim(), vault.policy.btc_network);
  if (!decoded.ok) return { ok: false, problem: { kind: "destination", problem: decoded.problem } };
  const text = amountText.trim();
  if (!/^\d{1,16}$/.test(text)) return { ok: false, problem: { kind: "amount" } };
  const amount = BigInt(text);
  if (amount < DUST_SATS || amount > max) return { ok: false, problem: { kind: "amount" } };
  let envelope: string;
  try {
    envelope = sealWatcherEnvelope("normal", vault.policy.watcher_x25519_pk);
  } catch {
    return { ok: false, problem: { kind: "seal" } };
  }
  return {
    ok: true,
    args: {
      vault_id: vault.vault_id,
      amount_sats: amount.toString(),
      destination: destination.trim(),
      fee_rate_sat_vb: FEE_RATE_SAT_VB,
      utxos: coins,
      envelope,
    },
  };
}

/** A Clawback's arguments: up to five confirmed coins of the Vault Address. */
export function planClawback(vault: Pick<Vault, "vault_id">, outpoints: readonly Outpoint[]) {
  const utxos = spendableCoins(outpoints);
  if (utxos.length === 0) return null;
  return { vault_id: vault.vault_id, utxos, fee_rate_sat_vb: FEE_RATE_SAT_VB };
}

/** True when the op is a pending withdrawal whose `executable_at` has passed at `nowMs`. */
export function isExecutableAt(op: SpendOp, nowMs: number): boolean {
  return (
    op.kind === "withdrawal" &&
    op.state === "pending" &&
    op.executable_at !== null &&
    BigInt(nowMs) * 1_000_000n >= BigInt(op.executable_at)
  );
}

export type VaultAction = "request" | "execute" | "clawback";

export interface GateInput {
  /** The action running now, if any. */
  running: VaultAction | null;
  /** The connected NEAR account; null without a wallet. */
  account: string | null;
  vault: Pick<Vault, "owner_account" | "state" | "policy">;
  /** True once a key file that matches this Vault is loaded. */
  keysLoaded: boolean;
  /** The open Withdrawal Request, if any. */
  op: SpendOp | null;
  /** The Vault Address's confirmed coins, while they are being read, or when they cannot be. */
  coins: readonly Outpoint[] | "loading" | "unreachable";
  nowMs: number;
}

/**
 * Why `action` cannot run now, in the words the page shows under its button, or null when it
 * can. Execute without an open request is not gated here (the page says how to open one).
 */
export function actionGate(action: VaultAction, input: GateInput): string | null {
  const g = copy.vault.page.gates;
  const { vault, op, coins } = input;
  if (input.running !== null) return g.busy;
  if (input.account === null) return g.wallet;
  if (action === "clawback") {
    if (vault.state === "pending_keys") return g.notActive;
    if (!vault.policy.guardians.some((guardian) => guardian.guardian_account === input.account)) {
      return g.guardian;
    }
  } else {
    if (vault.state === "clawed_back") return g.closed;
    if (vault.state !== "active") return g.notActive;
    if (input.account !== vault.owner_account) return g.owner(vault.owner_account);
  }
  if (!input.keysLoaded) return g.keys;
  if (action === "execute") {
    if (op === null) return null;
    if (op.state !== "pending") return copy.vault.page.pending.notPending;
    if (op.executable_at !== null && !isExecutableAt(op, input.nowMs)) {
      return copy.vault.page.pending.notYet(absoluteTime(nsToMs(op.executable_at), input.nowMs));
    }
    return null;
  }
  if (coins === "loading") return g.coins;
  if (coins === "unreachable") return copy.vault.page.btcUnreachable;
  if (coins.length === 0) return g.funds;
  return null;
}

// Reading the contract's answers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const STORED_SIGNATURE = /^0[23][0-9a-f]{128}$/;

/** A `SpendOp` as `get_op` / `begin_execute` return it, or null when it is not one. */
export function asSpendOp(value: unknown): SpendOp | null {
  if (!isRecord(value)) return null;
  if (typeof value.op_id !== "string" || typeof value.vault_id !== "string") return null;
  if (typeof value.kind !== "string" || typeof value.state !== "string") return null;
  if (!Array.isArray(value.sighashes) || !Array.isArray(value.signatures)) return null;
  if (!Array.isArray(value.utxos)) return null;
  const at = value.executable_at;
  if (at !== null && !(typeof at === "string" && /^\d{1,30}$/.test(at))) return null;
  return value as unknown as SpendOp;
}

/** A `Vault` as `get_vault` returns it, or null when it is not one. */
export function asVault(value: unknown): Vault | null {
  if (!isRecord(value) || typeof value.vault_id !== "string") return null;
  if (typeof value.owner_account !== "string" || typeof value.owner_key !== "string") return null;
  if (typeof value.state !== "string" || !isRecord(value.policy)) return null;
  const policy = value.policy;
  if (!Array.isArray(policy.guardians) || typeof policy.btc_network !== "string") return null;
  return { pending_change: null, ...value } as unknown as Vault;
}

/** The new Vault's id from a `create_vault` outcome: its return value, else its event log. */
export function createdVaultId(value: unknown, logs: readonly string[]): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(line.slice("EVENT_JSON:".length)) as unknown;
      if (!isRecord(event) || event.event !== "vault_created") continue;
      const data = Array.isArray(event.data) ? (event.data[0] as unknown) : null;
      if (isRecord(data) && typeof data.vault_id === "string" && /^\d+$/.test(data.vault_id)) {
        return data.vault_id;
      }
    } catch {
      // Not JSON: not ours.
    }
  }
  return null;
}

// Bitcoin

/** What a node says when it already has the transaction: the broadcast counts as done. */
export const ALREADY_KNOWN =
  /already in (the )?(mempool|block ?chain|utxo set)|txn-already-known|txn-already-in-mempool|already known/i;

export type BroadcastResult = { ok: true; txid: string } | { ok: false; message: string | null };

/** `POST <backend>/tx` with the raw transaction; a node that already has it counts as success. */
export async function broadcastTx(
  btcBackendUrl: string,
  hex: string,
  signal: AbortSignal,
): Promise<BroadcastResult> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${btcBackendUrl.replace(/\/+$/, "")}/tx`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: hex,
      signal: withTimeout(signal, 30_000),
    });
    text = (await response.text()).trim();
  } catch {
    return { ok: false, message: null };
  }
  if (response.ok && /^[0-9a-f]{64}$/.test(text)) return { ok: true, txid: text };
  if (ALREADY_KNOWN.test(text)) return { ok: true, txid: txidOf(hex) };
  return { ok: false, message: text.slice(0, 300) || `HTTP ${response.status}` };
}

// The flows

export interface ActionDeps {
  /** A contract call through the wallet (gas and deposit chosen by method). */
  call: (method: string, args: object) => Promise<CallOutcome>;
  view: (method: string, args: Record<string, unknown>) => Promise<ViewAnswer>;
  broadcast: (hex: string) => Promise<BroadcastResult>;
  sleep: (ms: number) => Promise<void>;
}

export type ActionStep =
  /** The wallet is asked to sign `method`; `input` for `sign_input`, of `inputs`. */
  | { kind: "wallet"; method: string; input?: number; inputs?: number }
  /** The page reads NEAR (an op, the Vault Kit). */
  | { kind: "reading" }
  /** The signed transaction goes to the Bitcoin backend. */
  | { kind: "broadcasting" };

export type ActionResult =
  /** A Withdrawal Request was accepted. */
  | { kind: "requested"; opId: string; op: SpendOp | null; hash: string | null }
  /** The spend is on Bitcoin (or the backend already had it). */
  | { kind: "broadcast"; txid: string; opId: string }
  /**
   * The contract or NEAR refused a call. `opId` (on these three) names the op a Clawback had
   * already started, so the next press resumes it instead of starting another.
   */
  | { kind: "refused"; code: ErrorCode | null; message: string; opId?: string }
  /** The user closed the wallet or it failed before sending. */
  | { kind: "rejected"; message: string; opId?: string }
  /** NEAR's answer could not be read, or NEAR did not answer in time. */
  | { kind: "unreadable"; opId?: string }
  /** The Bitcoin backend refused or did not answer; `hex` is the signed transaction. */
  | { kind: "broadcast-failed"; message: string | null; hex: string; opId: string };

type Failure = Extract<ActionResult, { kind: "refused" | "rejected" | "unreadable" }>;

function failure(outcome: Exclude<CallOutcome, { kind: "ok" }>, opId?: string): Failure {
  const op = opId === undefined ? {} : { opId };
  if (outcome.kind === "refused") {
    return { kind: "refused", code: outcome.code, message: outcome.message, ...op };
  }
  if (outcome.kind === "rejected") return { kind: "rejected", message: outcome.message, ...op };
  return { kind: "unreadable", ...op };
}

/** Sends a Withdrawal Request; reads the op back when NEAR shows it. */
export async function runRequest(
  deps: ActionDeps,
  args: WithdrawalArgs,
  onStep: (step: ActionStep) => void,
): Promise<ActionResult> {
  onStep({ kind: "wallet", method: "request_withdrawal" });
  const outcome = await deps.call("request_withdrawal", args);
  if (outcome.kind !== "ok") return failure(outcome);
  const opId =
    typeof outcome.value === "string" && /^\d+$/.test(outcome.value) ? outcome.value : null;
  if (opId === null) return { kind: "unreadable" };
  onStep({ kind: "reading" });
  const op = await readOp(deps, opId, () => true);
  return { kind: "requested", opId, op, hash: outcome.hash };
}

/**
 * `get_op` until `ready(op)`; the RPC is load-balanced, so a node may not show a fresh op or
 * signature yet. Null after `READ_ATTEMPTS` reads.
 */
async function readOp(
  deps: ActionDeps,
  opId: string,
  ready: (op: SpendOp) => boolean,
): Promise<SpendOp | null> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.sleep(RETRY_MS);
    const answer = await deps.view("get_op", { op_id: opId });
    if (answer.kind === "ok") {
      const op = asSpendOp(answer.value);
      if (op !== null && ready(op)) return op;
    } else if (
      answer.kind === "error" &&
      answer.code !== null &&
      answer.code !== "ERR_OP_NOT_FOUND"
    ) {
      // A known refusal is final; a generic RPC error (no code) is retried like no answer.
      return null;
    }
  }
  return null;
}

/** The witness script of the op's source, from `get_vault_kit`. */
async function witnessScript(
  deps: ActionDeps,
  vaultId: string,
  source: SpendOp["source"],
): Promise<string | null> {
  const answer = await deps.view("get_vault_kit", { vault_id: vaultId });
  if (answer.kind !== "ok" || !isRecord(answer.value)) return null;
  const script =
    source === "allowance" ? answer.value.allowance_script_hex : answer.value.vault_script_hex;
  return typeof script === "string" && /^[0-9a-f]+$/.test(script) ? script : null;
}

/**
 * Co-signs every input still unsigned (`sign_input`, one wallet approval each), signs locally,
 * assembles and broadcasts.
 */
async function signAssembleBroadcast(
  deps: ActionDeps,
  frozen: SpendOp,
  script: string,
  signer: { role: "owner" | "guardian"; secretKey: Uint8Array },
  onStep: (step: ActionStep) => void,
): Promise<ActionResult> {
  const op: SpendOp = { ...frozen, signatures: [...frozen.signatures] };
  const inputs = op.sighashes.length;
  for (let input = 0; input < inputs; input += 1) {
    const known = op.signatures[input];
    if (typeof known === "string" && STORED_SIGNATURE.test(known)) continue;
    onStep({ kind: "wallet", method: "sign_input", input, inputs });
    const outcome = await deps.call("sign_input", { op_id: op.op_id, input_index: input });
    if (outcome.kind !== "ok") return failure(outcome, op.op_id);
    op.signatures[input] =
      typeof outcome.value === "string" && STORED_SIGNATURE.test(outcome.value)
        ? outcome.value
        : null;
  }
  if (op.signatures.some((s) => s === null)) {
    onStep({ kind: "reading" });
    const signed = await readOp(deps, op.op_id, (read) =>
      read.signatures.every((s) => typeof s === "string" && STORED_SIGNATURE.test(s)),
    );
    if (signed === null) return { kind: "unreadable", opId: op.op_id };
    op.signatures = signed.signatures;
  }
  const hex = assembleSpendHex(op, script, signer);
  onStep({ kind: "broadcasting" });
  const sent = await deps.broadcast(hex);
  if (!sent.ok) return { kind: "broadcast-failed", message: sent.message, hex, opId: op.op_id };
  return { kind: "broadcast", txid: sent.txid, opId: op.op_id };
}

/** Executes a pending withdrawal whose Delay has passed, signed with the Owner Key. */
export async function runExecute(
  deps: ActionDeps,
  input: { vault: Pick<Vault, "vault_id" | "policy">; opId: string; ownerSecret: Uint8Array },
  onStep: (step: ActionStep) => void,
): Promise<ActionResult> {
  let envelope: string;
  try {
    envelope = sealWatcherEnvelope("normal", input.vault.policy.watcher_x25519_pk);
  } catch {
    return { kind: "refused", code: "ERR_BAD_ENVELOPE", message: "ERR_BAD_ENVELOPE" };
  }
  onStep({ kind: "wallet", method: "begin_execute" });
  const outcome = await deps.call("begin_execute", { op_id: input.opId, envelope });
  if (outcome.kind !== "ok") return failure(outcome);
  const op = asSpendOp(outcome.value);
  if (op === null || op.unsigned_tx_hex === null) return { kind: "unreadable" };
  // The witness script of the coins' own address, from the frozen op.
  onStep({ kind: "reading" });
  const script = await witnessScript(deps, input.vault.vault_id, op.source);
  if (script === null) return { kind: "unreadable" };
  return signAssembleBroadcast(
    deps,
    op,
    script,
    { role: "owner", secretKey: input.ownerSecret },
    onStep,
  );
}

/**
 * Claws the Vault's confirmed coins back to its Recovery Address, signed with the Guardian Key.
 * With `resumeOpId` (a Clawback this page started that stopped after `begin_clawback`) it
 * carries that op on instead: `begin_clawback` again would be refused with
 * `ERR_OUTPOINT_RESERVED`, and the inputs already co-signed are not asked for again.
 */
export async function runClawback(
  deps: ActionDeps,
  input: {
    vault: Pick<Vault, "vault_id">;
    outpoints: readonly Outpoint[];
    guardianSecret: Uint8Array;
    resumeOpId?: string | null;
  },
  onStep: (step: ActionStep) => void,
): Promise<ActionResult> {
  let opId = input.resumeOpId ?? null;
  if (opId === null) {
    const args = planClawback(input.vault, input.outpoints);
    if (args === null) {
      return { kind: "refused", code: "ERR_NO_INPUTS", message: "ERR_NO_INPUTS" };
    }
    onStep({ kind: "wallet", method: "begin_clawback" });
    const outcome = await deps.call("begin_clawback", args);
    if (outcome.kind !== "ok") return failure(outcome);
    opId = typeof outcome.value === "string" && /^\d+$/.test(outcome.value) ? outcome.value : null;
    if (opId === null) return { kind: "unreadable" };
  }
  onStep({ kind: "reading" });
  const op = await readOp(deps, opId, (read) => read.unsigned_tx_hex !== null);
  if (op === null) return { kind: "unreadable", opId };
  const script = await witnessScript(deps, input.vault.vault_id, op.source);
  if (script === null) return { kind: "unreadable", opId };
  return signAssembleBroadcast(
    deps,
    op,
    script,
    { role: "guardian", secretKey: input.guardianSecret },
    onStep,
  );
}

/**
 * `get_vault` until the Vault is active. The RPC is load-balanced, so `ERR_VAULT_NOT_FOUND` and
 * `ERR_VAULT_NOT_ACTIVE` right after `create_vault` are transient, as are no answer and a
 * generic RPC error. Null after
 * `attempts` reads.
 */
export async function waitForActive(
  view: ActionDeps["view"],
  sleep: ActionDeps["sleep"],
  vaultId: string,
  attempts = 40,
): Promise<Vault | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_MS);
    const answer = await view("get_vault", { vault_id: vaultId });
    if (answer.kind === "ok") {
      const vault = asVault(answer.value);
      if (vault?.state === "active") return vault;
    } else if (
      answer.kind === "error" &&
      answer.code !== null &&
      answer.code !== "ERR_VAULT_NOT_FOUND" &&
      answer.code !== "ERR_VAULT_NOT_ACTIVE"
    ) {
      return null;
    }
  }
  return null;
}
