/**
 * The Clawback fee rule, mirroring the contract's `build_sweep` sizing and `clawback_fee_cap`
 * (contracts/vault/src/core/tx.rs). Pure: the runner picks the rate once, before `begin_clawback`.
 */

/** A DER signature with its sighash byte is at most 73 bytes. */
const MAX_SIGNATURE_BYTES = 73;
/** The widest segwit output script (v0 P2WSH or v1 P2TR): OP_n, push 32, program. */
const MAX_SEGWIT_OUTPUT_SCRIPT = 34;

function varintLength(n: number): number {
  if (n <= 0xfc) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffff_ffff) return 5;
  return 9;
}

/**
 * Witness bytes of one Clawback Path input: item count, the CHECKMULTISIG dummy, the Guardian
 * and Co-signer signatures, the 0x01 selector, the empty outer selector and the script.
 */
export function clawbackWitnessSize(scriptLength: number): number {
  return (
    1 + 1 + 2 * (1 + MAX_SIGNATURE_BYTES) + (1 + 1) + 1 + varintLength(scriptLength) + scriptLength
  );
}

/**
 * Output script length of a segwit address, read from its bech32 data length (version, program,
 * 6-character checksum). Anything unreadable counts as the widest segwit script, which only
 * overestimates the size and so keeps the chosen rate under the contract's cap.
 */
export function outputScriptLength(address: string): number {
  const separator = address.lastIndexOf("1");
  const dataChars = address.length - separator - 1 - 1 - 6;
  if (separator < 1 || dataChars <= 0) return MAX_SEGWIT_OUTPUT_SCRIPT;
  const program = Math.floor((dataChars * 5) / 8);
  if (program < 2 || program > 40) return MAX_SEGWIT_OUTPUT_SCRIPT;
  return 2 + program;
}

/**
 * Virtual size of a sweep of `inputs` Clawback Path inputs to one output: the unsigned
 * serialization (version, inputs with empty scriptSig and RBF sequence, one output, locktime),
 * plus 2 weight units for the segwit marker and flag, plus each input's witness.
 */
export function sweepVsize(
  inputs: number,
  witnessScriptLength: number,
  outputScriptLen: number,
): number {
  const unsigned =
    4 +
    varintLength(inputs) +
    inputs * (32 + 4 + 1 + 4) +
    varintLength(1) +
    8 +
    varintLength(outputScriptLen) +
    outputScriptLen +
    4;
  const weight = unsigned * 4 + 2 + inputs * clawbackWitnessSize(witnessScriptLength);
  return Math.ceil(weight / 4);
}

/** min(2 × Fee Cap, 10% of the amount swept), as the contract enforces it. */
export function clawbackFeeCap(feeCapSats: bigint, totalSats: bigint): bigint {
  const double = feeCapSats * 2n;
  const tenth = totalSats / 10n;
  return double < tenth ? double : tenth;
}

/** Bitcoin Core's default -incrementalrelayfee, in sat/vB. */
const INCREMENTAL_RELAY_SAT_VB = 1n;

export interface FeeConflict {
  /** The conflict's own fee rate. */
  fee_rate_sat_vb: number;
  /** Fees of the conflict and its mempool descendants; unknown for ops not yet broadcast. */
  descendant_fees_sats?: string | null;
}

export interface FeeDecision {
  /** The rate to pass to `begin_clawback`; 0 when even 1 sat/vB exceeds the cap. */
  fee_rate_sat_vb: number;
  /** The largest integer rate the Clawback fee cap allows. */
  cap_rate_sat_vb: number;
  fee_sats: string;
  /** A conflict pays more than half the chosen rate: the 2× rule cannot be met. */
  below_double: boolean;
  /**
   * The mempool conflicts' fees with descendants (CPFP), plus 1 sat/vB of our size, reach our fee:
   * the replacement will be refused.
   */
  pinned: boolean;
}

/**
 * No conflict: the base rate (never above the cap rate). Any conflict: the cap rate, the largest
 * integer rate whose fee (vsize × rate) fits the Clawback fee cap.
 */
export function clawbackFeeRate(input: {
  vsize: number;
  totalSats: bigint;
  feeCapSats: bigint;
  baseRate: number;
  conflicts: FeeConflict[];
}): FeeDecision {
  const cap = clawbackFeeCap(input.feeCapSats, input.totalSats);
  const capRate = Number(cap / BigInt(input.vsize));
  const rate = input.conflicts.length === 0 ? Math.min(input.baseRate, capRate) : capRate;
  const fee = BigInt(input.vsize) * BigInt(rate);
  // A replacement must pay every evicted transaction's fees plus the incremental relay fee for its
  // own size (BIP125 rules 3 and 4); the mempool conflicts and their descendants are all evicted.
  const mempool = input.conflicts.filter((c) => c.descendant_fees_sats != null);
  const evicted = mempool.reduce((sum, c) => sum + BigInt(c.descendant_fees_sats as string), 0n);
  return {
    fee_rate_sat_vb: rate,
    cap_rate_sat_vb: capRate,
    fee_sats: fee.toString(),
    below_double: input.conflicts.some((c) => rate < 2 * c.fee_rate_sat_vb),
    pinned: mempool.length > 0 && evicted + BigInt(input.vsize) * INCREMENTAL_RELAY_SAT_VB >= fee,
  };
}
