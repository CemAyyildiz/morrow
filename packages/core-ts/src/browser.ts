/**
 * The browser-safe part of core-ts: pure modules only (explorer links, error codes with their
 * meanings, event kinds and types, transaction failure reading) plus what "Try with these keys"
 * needs: NEAR transaction signing, the Watcher Envelope and SegWit address checks, built on
 * @noble and @scure. Nothing here may import near-api-js, libsodium or bitcoinjs-lib, directly
 * or through another module: `browser.test.ts` walks the import graph and allows only those
 * small pure packages, and the web build fails if a heavy one reaches its bundle.
 */
export { bitcoinTxUrl, nearAccountUrl, nearTxUrl, type NearNetwork } from "./xray/links.js";
export {
  ERROR_CODES,
  MorrowContractError,
  isErrorCode,
  parseContractError,
  type ErrorCode,
} from "./contract/errors.js";
export {
  EVENT_KINDS,
  type EventData,
  type EventKind,
  type MorrowEvent,
} from "./contract/events.js";
export type {
  AccountId,
  BtcNetwork,
  Guardian,
  GuardianKind,
  Hex,
  Outpoint,
  Policy,
  PolicyChange,
  PolicyChangeFields,
  SpendOpKind,
  U64,
  Vault,
  VaultState,
} from "./contract/types.js";
export { failureKind, txFailure, type TxFailure } from "./xray/failure.js";
export type {
  RpcAction,
  RpcExecutionStatus,
  RpcOutcome,
  RpcReceipt,
  RpcTxStatus,
} from "./xray/ports.js";
export {
  NearKeyError,
  decodeBlockHash,
  encodeFunctionCallTx,
  parseNearKey,
  signFunctionCall,
  type FunctionCallTx,
  type NearKey,
  type SignedFunctionCall,
} from "./near/browser-tx.js";
export { sealWatcherEnvelope, type WatcherEnvelopeFlag } from "./crypto/browser-envelope.js";
export {
  SEGWIT_HRP,
  decodeSegwitAddress,
  randomP2wpkhAddress,
  type SegwitAddress,
  type SegwitAddressProblem,
} from "./bitcoin/browser-address.js";
