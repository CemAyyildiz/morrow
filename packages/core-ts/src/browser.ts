/**
 * The browser-safe part of core-ts: pure modules only (explorer links, error codes with their
 * meanings, event kinds and types, transaction failure reading) plus what "Try with these keys"
 * needs: NEAR transaction signing, the Watcher Envelope and SegWit address checks, the wallet
 * pages' key generation, signet Policy and spend completion (`assembleSpendHex`), plus the Proof
 * Page's Vault Script decoding and P2WSH address recompute, and X-Ray's assembly (`buildXRay`
 * with its fetch-based RPC and FastNEAR locator), built on @noble and @scure. Nothing
 * here may import near-api-js, libsodium or bitcoinjs-lib, directly or through another module:
 * `browser.test.ts` walks the import graph and allows only those small pure packages, and the
 * web build fails if a heavy one reaches its bundle.
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
export {
  canonicalChangesJson,
  isLoosening,
  looseningReasons,
  presetPolicy,
  validatePolicy,
  type PresetInputs,
  type PresetName,
} from "./contract/policy.js";
export {
  SIGNET_DELAYS_NS,
  SIGNET_POLICY,
  signetPolicy,
  type SignetDelay,
  type SignetPolicyInputs,
} from "./contract/signet-policy.js";
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
  ScriptPath,
  SpendOp,
  SpendOpKind,
  SpendOpState,
  SpendSource,
  U64,
  Vault,
  VaultKit,
  VaultState,
  WitnessTemplate,
} from "./contract/types.js";
export { failureKind, txFailure, type TxFailure } from "./xray/failure.js";
export {
  FastNearLocator,
  FetchNearRpc,
  NearRpcError,
  chainLocators,
  hintLocator,
  type FastNearLocatorOptions,
  type NearRpc,
  type RpcAction,
  type RpcExecutionStatus,
  type RpcOutcome,
  type RpcReceipt,
  type RpcTxStatus,
  type TxHint,
  type TxLocator,
  type TxQuery,
} from "./xray/ports.js";
export { RECEIPTS_UNAVAILABLE, buildXRay, type XRayDeps } from "./xray/build.js";
export {
  XRayInputError,
  type BitcoinStage,
  type EventFacts,
  type MpcInput,
  type MpcStage,
  type NearTxRef,
  type Refusal,
  type RuleEvent,
  type RuleStage,
  type ScriptStage,
  type Source,
  type Sourced,
  type StageStatus,
  type XRay,
  type XRayInput,
} from "./xray/types.js";
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
  compressedPublicKey,
  decodeWif,
  encodeWif,
  p2wpkhAddress,
  randomSecretKey,
  randomX25519SecretKey,
  x25519PublicKey,
} from "./crypto/browser-keys.js";
export { assembleSpendHex } from "./spend/assemble-browser.js";
export type { LocalSigner } from "./spend/signatures.js";
export { TxParseError, txidOf } from "./bitcoin/browser-txid.js";
export {
  linkRequestDigest,
  linkRequestMessage,
  linkRequestProblems,
  signLinkRequest,
  verifyLinkRequest,
  type LinkRequest,
  type LinkRequestRole,
} from "./crypto/link-request.js";
// The full entry's own hex helpers (pure), so both entries export the same functions.
export { bytesToHex, hexToBytes } from "./crypto/hex.js";
export {
  SEGWIT_HRP,
  decodeSegwitAddress,
  randomP2wpkhAddress,
  type SegwitAddress,
  type SegwitAddressProblem,
} from "./bitcoin/browser-address.js";
export {
  compareScripts,
  decodeScript,
  encodeScriptNumber,
  opcodeName,
  p2wshAddress,
  sameOp,
  scriptNumber,
  scriptPaths,
  vaultScriptTemplate,
  type ScriptDifference,
  type ScriptOp,
  type VaultScriptElement,
  type VaultScriptRole,
  type VaultScriptTemplate,
} from "./bitcoin/browser-script.js";
