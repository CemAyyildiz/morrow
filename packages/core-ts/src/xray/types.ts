import type { ErrorCode } from "../contract/errors.js";
import type { EventKind } from "../contract/events.js";
import type {
  AccountId,
  BtcNetwork,
  Hex,
  ScriptPath,
  SpendOpState,
  SpendSource,
  U64,
  WitnessTemplate,
} from "../contract/types.js";

/** A NEAR transaction reference. RPC `tx` lookups need the sender as well as the hash. */
export interface NearTxRef {
  hash: string;
  /** Null when only the hash is known; the locator's `senderOf` resolves it. */
  senderId: AccountId | null;
}

/** What to X-Ray: one op, or one refused call to the Vault Contract. */
export type XRayInput = { opId: U64 } | { refusedTx: { hash: string; senderId?: AccountId } };

/** Where a value was read. */
export interface Source {
  /** The exact call that returned the value, e.g. `query call_function <contract> get_op {"op_id":"25"}`. */
  ref: string;
  /** Explorer link, or null when there is none (views, regtest). */
  url: string | null;
}

/** A value with its source. Every value an X-Ray shows is one of these. */
export interface Sourced<T> {
  value: T;
  source: Source;
}

export type StageStatus = "done" | "pending" | "refused" | "not_reached" | "failed";

/** Stage 1: the script path the op spends through. */
export interface ScriptStage {
  status: StageStatus;
  path: Sourced<ScriptPath> | null;
  /** Which Vault Kit script the coins come from (`op.source`). */
  coinSource: Sourced<SpendSource> | null;
  scriptHex: Sourced<Hex> | null;
  address: Sourced<string> | null;
  template: Sourced<WitnessTemplate> | null;
}

/** Primitive event fields, keyed as the contract emits them. */
export type EventFacts = Record<string, Sourced<string | number | boolean | null>>;

/** One contract event for the op, as `events_since` returned it. */
export interface RuleEvent {
  seq: Sourced<U64>;
  kind: Sourced<EventKind>;
  blockTimestamp: Sourced<U64>;
  facts: EventFacts;
}

/** A refused call: the contract's `ERR_*` code and the values it was judged on. */
export interface Refusal {
  code: Sourced<ErrorCode>;
  /** The Glossary message for the code (`ERROR_CODES`). */
  gloss: Sourced<string>;
  method: Sourced<string>;
  args: Sourced<Record<string, unknown>>;
  txHash: Sourced<string>;
  receiptId: Sourced<string>;
  facts: {
    /**
     * The failing block's timestamp: the contract's "now" for this call. Null when the block
     * header could not be read.
     */
    blockTimestamp: Sourced<U64> | null;
    /**
     * The named op's `executable_at` at the failing block's parent (the state the call was
     * judged on), when it has one. Null when the op or the parent block could not be read.
     */
    executableAt: Sourced<U64> | null;
    /** The named op's state at the failing block's parent. */
    opState: Sourced<SpendOpState> | null;
  };
}

/** Stage 2: the contract rule and its result. */
export interface RuleStage {
  status: StageStatus;
  /** The op's events, ascending. Empty for a refusal. */
  events: RuleEvent[];
  opState: Sourced<SpendOpState> | null;
  executableAt: Sourced<U64> | null;
  /** From the `op_frozen` event, when the contract emitted it. */
  feeSats: Sourced<U64> | null;
  /** The Clawback op that voided this op. */
  voidedBy: Sourced<U64> | null;
  refusal: Refusal | null;
}

/** The MPC co-signature for one input. */
export interface MpcInput {
  status: StageStatus;
  index: Sourced<number>;
  /** The sighash the contract stored (`get_op`). */
  sighash: Sourced<Hex>;
  /** The payload the contract sent to the signer (`sign` receipt). */
  payload: Sourced<Hex> | null;
  domainId: Sourced<number> | null;
  path: Sourced<string> | null;
  signer: Sourced<AccountId> | null;
  txHash: Sourced<string> | null;
  signReceiptId: Sourced<string> | null;
  responseReceiptId: Sourced<string> | null;
  callbackReceiptId: Sourced<string> | null;
  /** The signer's response (`big_r`, `s`, ...), as returned. */
  response: Sourced<Record<string, unknown>> | null;
  /** The value `on_signed` returned. */
  callbackValue: Sourced<Hex> | null;
  /** The signature the contract stored (`get_op`). */
  signature: Sourced<Hex> | null;
  participants: Sourced<number> | null;
  threshold: Sourced<number> | null;
  protocol: Sourced<string> | null;
  /** Why some values are missing or the stage failed; null when nothing to say. */
  note: string | null;
}

/** Stage 3: the NEAR MPC request and response, per input. */
export interface MpcStage {
  status: StageStatus;
  inputs: MpcInput[];
}

/** Stage 4: the Bitcoin transaction. */
export interface BitcoinStage {
  status: StageStatus;
  txid: Sourced<Hex> | null;
  confirmations: Sourced<number> | null;
  blockHeight: Sourced<number | null> | null;
}

export interface XRay {
  opId: Sourced<U64> | null;
  vaultId: Sourced<U64> | null;
  btcNetwork: Sourced<BtcNetwork> | null;
  script: ScriptStage;
  rule: RuleStage;
  mpc: MpcStage;
  bitcoin: BitcoinStage;
}

/** The input names no op of this contract, or no refused call to it. */
export class XRayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XRayInputError";
  }
}
