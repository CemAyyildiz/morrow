/**
 * The browser-safe part of core-ts: pure modules only (explorer links, error codes with their
 * meanings, event kinds and types). Nothing here may import near-api-js, libsodium or
 * bitcoinjs-lib, directly or through another module: `browser.test.ts` walks the import graph,
 * and the web build fails if one of them reaches its bundle.
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
  Hex,
  Outpoint,
  PolicyChangeFields,
  SpendOpKind,
  U64,
} from "./contract/types.js";
