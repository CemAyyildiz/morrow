/** X-Ray data assembly: one op (or refused call) through script, rule, MPC signature and Bitcoin tx. */
export { RECEIPTS_UNAVAILABLE, buildXRay, type XRayDeps } from "./build.js";
export { failureKind, txFailure, type TxFailure } from "./failure.js";
export { bitcoinTxUrl, nearAccountUrl, nearTxUrl, type NearNetwork } from "./links.js";
export {
  FastNearLocator,
  FetchNearRpc,
  NearRpcError,
  chainLocators,
  hintLocator,
  type FastNearLocatorOptions,
  type NearRpc,
  type RpcAction,
  type RpcBlockHeader,
  type RpcExecutionStatus,
  type RpcFunctionCall,
  type RpcOutcome,
  type RpcReceipt,
  type RpcTxStatus,
  type SignedTx,
  type TxHint,
  type TxLocator,
  type TxQuery,
} from "./ports.js";
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
} from "./types.js";
