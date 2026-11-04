// The Vault Script, read and rebuilt in the browser: decode a contract-published script opcode
// by opcode, recompute its P2WSH address, rebuild the three-path template from a Vault's keys
// (exactly as contracts/vault/src/core/script.rs `build_vault_script` does) and find the first
// element where two scripts differ. Pure: @noble/hashes and @scure/base only, no bitcoinjs-lib.
// The contract stays the authority for scripts: this only hashes what it publishes and checks
// it against what `get_vault` states.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import type { BtcNetwork, Hex, ScriptPath } from "../contract/types.js";
import { SEGWIT_HRP } from "./browser-address.js";

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_IF = 0x63;
const OP_NOTIF = 0x64;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKMULTISIG = 0xae;
const OP_CHECKSEQUENCEVERIFY = 0xb2;

/** Bitcoin Core's opcode names (script.cpp `GetOpName`), for every non-push opcode. */
const NAMES: Record<number, string> = {
  0x00: "OP_0",
  0x4c: "OP_PUSHDATA1",
  0x4d: "OP_PUSHDATA2",
  0x4e: "OP_PUSHDATA4",
  0x4f: "OP_1NEGATE",
  0x50: "OP_RESERVED",
  0x61: "OP_NOP",
  0x62: "OP_VER",
  0x63: "OP_IF",
  0x64: "OP_NOTIF",
  0x65: "OP_VERIF",
  0x66: "OP_VERNOTIF",
  0x67: "OP_ELSE",
  0x68: "OP_ENDIF",
  0x69: "OP_VERIFY",
  0x6a: "OP_RETURN",
  0x6b: "OP_TOALTSTACK",
  0x6c: "OP_FROMALTSTACK",
  0x6d: "OP_2DROP",
  0x6e: "OP_2DUP",
  0x6f: "OP_3DUP",
  0x70: "OP_2OVER",
  0x71: "OP_2ROT",
  0x72: "OP_2SWAP",
  0x73: "OP_IFDUP",
  0x74: "OP_DEPTH",
  0x75: "OP_DROP",
  0x76: "OP_DUP",
  0x77: "OP_NIP",
  0x78: "OP_OVER",
  0x79: "OP_PICK",
  0x7a: "OP_ROLL",
  0x7b: "OP_ROT",
  0x7c: "OP_SWAP",
  0x7d: "OP_TUCK",
  0x7e: "OP_CAT",
  0x7f: "OP_SUBSTR",
  0x80: "OP_LEFT",
  0x81: "OP_RIGHT",
  0x82: "OP_SIZE",
  0x83: "OP_INVERT",
  0x84: "OP_AND",
  0x85: "OP_OR",
  0x86: "OP_XOR",
  0x87: "OP_EQUAL",
  0x88: "OP_EQUALVERIFY",
  0x89: "OP_RESERVED1",
  0x8a: "OP_RESERVED2",
  0x8b: "OP_1ADD",
  0x8c: "OP_1SUB",
  0x8d: "OP_2MUL",
  0x8e: "OP_2DIV",
  0x8f: "OP_NEGATE",
  0x90: "OP_ABS",
  0x91: "OP_NOT",
  0x92: "OP_0NOTEQUAL",
  0x93: "OP_ADD",
  0x94: "OP_SUB",
  0x95: "OP_MUL",
  0x96: "OP_DIV",
  0x97: "OP_MOD",
  0x98: "OP_LSHIFT",
  0x99: "OP_RSHIFT",
  0x9a: "OP_BOOLAND",
  0x9b: "OP_BOOLOR",
  0x9c: "OP_NUMEQUAL",
  0x9d: "OP_NUMEQUALVERIFY",
  0x9e: "OP_NUMNOTEQUAL",
  0x9f: "OP_LESSTHAN",
  0xa0: "OP_GREATERTHAN",
  0xa1: "OP_LESSTHANOREQUAL",
  0xa2: "OP_GREATERTHANOREQUAL",
  0xa3: "OP_MIN",
  0xa4: "OP_MAX",
  0xa5: "OP_WITHIN",
  0xa6: "OP_RIPEMD160",
  0xa7: "OP_SHA1",
  0xa8: "OP_SHA256",
  0xa9: "OP_HASH160",
  0xaa: "OP_HASH256",
  0xab: "OP_CODESEPARATOR",
  0xac: "OP_CHECKSIG",
  0xad: "OP_CHECKSIGVERIFY",
  0xae: "OP_CHECKMULTISIG",
  0xaf: "OP_CHECKMULTISIGVERIFY",
  0xb0: "OP_NOP1",
  0xb1: "OP_CHECKLOCKTIMEVERIFY",
  0xb2: "OP_CHECKSEQUENCEVERIFY",
  0xb3: "OP_NOP4",
  0xb4: "OP_NOP5",
  0xb5: "OP_NOP6",
  0xb6: "OP_NOP7",
  0xb7: "OP_NOP8",
  0xb8: "OP_NOP9",
  0xb9: "OP_NOP10",
  0xba: "OP_CHECKSIGADD",
  0xff: "OP_INVALIDOPCODE",
};

/** The name of opcode `code`: `OP_CHECKSIG`, `OP_7`, `OP_PUSHBYTES_33`, `OP_UNKNOWN_0xbb`. */
export function opcodeName(code: number): string {
  if (code >= OP_1 && code <= OP_16) return `OP_${code - OP_1 + 1}`;
  if (code >= 0x01 && code <= 0x4b) return `OP_PUSHBYTES_${code}`;
  return NAMES[code] ?? `OP_UNKNOWN_0x${code.toString(16).padStart(2, "0")}`;
}

/**
 * One element of a decoded script, at byte `offset`, `size` bytes long (opcode and data).
 * - `op`: an opcode without data (OP_0 and OP_1..OP_16 included).
 * - `push`: a data push (OP_PUSHBYTES_n or OP_PUSHDATA1/2/4) and its `data`.
 * - `truncated`: a push whose length runs past the end of the script; it takes the rest.
 */
export type ScriptOp =
  | { kind: "op"; offset: number; size: number; opcode: number; name: string }
  | { kind: "push"; offset: number; size: number; opcode: number; name: string; data: Uint8Array }
  | { kind: "truncated"; offset: number; size: number; opcode: number; name: string };

/** Decodes `script` element by element, the way Bitcoin Core's `GetScriptOp` reads it. */
export function decodeScript(script: Uint8Array): ScriptOp[] {
  const ops: ScriptOp[] = [];
  let at = 0;
  while (at < script.length) {
    const offset = at;
    const opcode = script[at++] as number;
    const name = opcodeName(opcode);
    if (opcode === OP_0 || opcode > OP_PUSHDATA4) {
      ops.push({ kind: "op", offset, size: 1, opcode, name });
      continue;
    }
    let length = opcode;
    const width =
      opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : opcode === OP_PUSHDATA4 ? 4 : 0;
    if (at + width > script.length) {
      ops.push({ kind: "truncated", offset, size: script.length - offset, opcode, name });
      break;
    }
    if (width > 0) {
      length = 0;
      for (let i = width - 1; i >= 0; i--) length = length * 256 + (script[at + i] as number);
      at += width;
    }
    if (at + length > script.length) {
      ops.push({ kind: "truncated", offset, size: script.length - offset, opcode, name });
      break;
    }
    ops.push({
      kind: "push",
      offset,
      size: at + length - offset,
      opcode,
      name,
      data: script.slice(at, at + length),
    });
    at += length;
  }
  return ops;
}

/** The P2WSH address of `script` on `network`: segwit v0, program `sha256(script)`. */
export function p2wshAddress(script: Uint8Array, network: BtcNetwork): string {
  return bech32.encode(SEGWIT_HRP[network], [0, ...bech32.toWords(sha256(script))]);
}

/**
 * The minimal push of a non-negative script number, as the contract's `push_number`: OP_0,
 * OP_1..OP_16, otherwise the shortest little-endian CScriptNum bytes (a 0x00 added when the top
 * bit would read as a sign).
 */
export function encodeScriptNumber(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`not a non-negative script number: ${value}`);
  }
  if (value === 0) return Uint8Array.of(OP_0);
  if (value <= 16) return Uint8Array.of(OP_1 + value - 1);
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.push(rest % 256);
  if (((bytes.at(-1) as number) & 0x80) !== 0) bytes.push(0x00);
  return Uint8Array.of(bytes.length, ...bytes);
}

/**
 * The number an element pushes: OP_0, OP_1NEGATE, OP_1..OP_16, or a CScriptNum push of at most
 * 4 bytes, minimal or not. Null for anything else.
 */
export function scriptNumber(op: ScriptOp): number | null {
  if (op.kind === "op") {
    if (op.opcode === OP_0) return 0;
    if (op.opcode === OP_1NEGATE) return -1;
    if (op.opcode >= OP_1 && op.opcode <= OP_16) return op.opcode - OP_1 + 1;
    return null;
  }
  if (op.kind !== "push" || op.data.length > 4) return null;
  if (op.data.length === 0) return 0;
  let value = 0;
  for (let i = op.data.length - 1; i >= 0; i--) value = value * 256 + (op.data[i] as number);
  const top = 0x80 * 256 ** (op.data.length - 1);
  return value >= top ? -(value - top) : value;
}

/** What an element of the Vault Script is for. */
export type VaultScriptRole =
  | "branch"
  | "owner_key"
  | "cosigner_key"
  | "guardian_key"
  | "threshold"
  | "guardian_count"
  | "timelock"
  | "opcode";

/** One element of the rebuilt template: its op, what it is for and the path it is on. */
export interface VaultScriptElement {
  op: ScriptOp;
  role: VaultScriptRole;
  /** The path the element is on; for OP_IF and OP_ELSE the path they open; null for OP_ENDIF. */
  path: ScriptPath | null;
  /** For a Guardian key: its place in the Policy's Guardian list, from 0. */
  guardian?: number;
}

export interface VaultScriptTemplate {
  script: Uint8Array;
  elements: VaultScriptElement[];
}

const keyBytes = (key: Hex | Uint8Array) => (typeof key === "string" ? hexToBytes(key) : key);

/** A direct push of `data` (keys are 33 bytes, so never more than 75). */
function pushBytes(data: Uint8Array): Uint8Array {
  if (data.length < 1 || data.length > 0x4b) {
    throw new RangeError(`a key push must be 1 to 75 bytes, got ${data.length}`);
  }
  return Uint8Array.of(data.length, ...data);
}

/**
 * The Vault Script for these keys and timelock, element by element, byte for byte the
 * contract's `build_vault_script`:
 * `OP_IF <owner> OP_CHECKSIGVERIFY <cosigner> OP_CHECKSIG
 *  OP_ELSE OP_IF <cosigner> OP_CHECKSIGVERIFY OP_1 <guardians…> <n> OP_CHECKMULTISIG
 *  OP_ELSE <timelock> OP_CHECKSEQUENCEVERIFY OP_DROP <owner> OP_CHECKSIG OP_ENDIF OP_ENDIF`.
 * Withdrawal: Owner + Co-signer; Clawback: Co-signer + 1-of-n Guardians; Escape: Owner after
 * the CSV of `escapeTimelockBlocks` blocks.
 */
export function vaultScriptTemplate(
  ownerKey: Hex | Uint8Array,
  cosignerKey: Hex | Uint8Array,
  guardianKeys: readonly (Hex | Uint8Array)[],
  escapeTimelockBlocks: number,
): VaultScriptTemplate {
  const owner = pushBytes(keyBytes(ownerKey));
  const cosigner = pushBytes(keyBytes(cosignerKey));
  const guardians = guardianKeys.map((key) => pushBytes(keyBytes(key)));
  const parts: { bytes: Uint8Array; role: VaultScriptRole; path: ScriptPath | null; g?: number }[] =
    [];
  const add = (
    bytes: Uint8Array | number,
    role: VaultScriptRole,
    path: ScriptPath | null,
    g?: number,
  ) =>
    parts.push({
      bytes: typeof bytes === "number" ? Uint8Array.of(bytes) : bytes,
      role,
      path,
      ...(g === undefined ? {} : { g }),
    });
  add(OP_IF, "branch", "withdrawal");
  add(owner, "owner_key", "withdrawal");
  add(OP_CHECKSIGVERIFY, "opcode", "withdrawal");
  add(cosigner, "cosigner_key", "withdrawal");
  add(OP_CHECKSIG, "opcode", "withdrawal");
  add(OP_ELSE, "branch", "clawback");
  add(OP_IF, "branch", "clawback");
  add(cosigner, "cosigner_key", "clawback");
  add(OP_CHECKSIGVERIFY, "opcode", "clawback");
  add(OP_1, "threshold", "clawback");
  guardians.forEach((push, g) => add(push, "guardian_key", "clawback", g));
  add(encodeScriptNumber(guardians.length), "guardian_count", "clawback");
  add(OP_CHECKMULTISIG, "opcode", "clawback");
  add(OP_ELSE, "branch", "escape");
  add(encodeScriptNumber(escapeTimelockBlocks), "timelock", "escape");
  add(OP_CHECKSEQUENCEVERIFY, "opcode", "escape");
  add(OP_DROP, "opcode", "escape");
  add(owner, "owner_key", "escape");
  add(OP_CHECKSIG, "opcode", "escape");
  add(OP_ENDIF, "branch", null);
  add(OP_ENDIF, "branch", null);

  const script = new Uint8Array(parts.reduce((total, part) => total + part.bytes.length, 0));
  let at = 0;
  for (const part of parts) {
    script.set(part.bytes, at);
    at += part.bytes.length;
  }
  const ops = decodeScript(script);
  const elements = parts.map((part, i) => ({
    op: ops[i] as ScriptOp,
    role: part.role,
    path: part.path,
    ...(part.g === undefined ? {} : { guardian: part.g }),
  }));
  return { script, elements };
}

/** Whether two elements are the same bytes. */
export function sameOp(a: ScriptOp, b: ScriptOp): boolean {
  if (a.kind !== b.kind || a.opcode !== b.opcode || a.size !== b.size) return false;
  if (a.kind !== "push" || b.kind !== "push") return true;
  return bytesToHex(a.data) === bytesToHex(b.data);
}

/** Where two scripts first differ: the element `index`, and each side's element there. */
export interface ScriptDifference {
  index: number;
  /** Null when `actual` ended first. */
  actual: ScriptOp | null;
  /** Null when `actual` has more elements than `expected`. */
  expected: ScriptOp | null;
}

/** The first element where `actual` differs from `expected`; null when they are the same. */
export function compareScripts(
  actual: readonly ScriptOp[],
  expected: readonly ScriptOp[],
): ScriptDifference | null {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index++) {
    const a = actual[index] ?? null;
    const e = expected[index] ?? null;
    if (a === null || e === null || !sameOp(a, e)) return { index, actual: a, expected: e };
  }
  return null;
}

/**
 * The path each element of a decoded script is on, read from its IF / ELSE / ENDIF structure
 * the way the Vault Script nests them: the outer IF branch is the Withdrawal Path, the inner IF
 * branch of the outer ELSE the Clawback Path and the inner ELSE the Escape Path. OP_IF and
 * OP_ELSE carry the path they open; OP_ENDIF and anything outside those branches null. An
 * OP_NOTIF inverts its arms, which the Vault Script never does: everything under one is on no
 * path.
 */
export function scriptPaths(ops: readonly ScriptOp[]): (ScriptPath | null)[] {
  /** The branch taken at each open IF: 0 for its IF arm, 1 after its ELSE. */
  const stack: number[] = [];
  /** How many of the open IFs are OP_NOTIF. */
  let inverted = 0;
  const notifs: boolean[] = [];
  const pathOf = (): ScriptPath | null => {
    const [outer, inner] = stack;
    if (inverted > 0) return null;
    if (stack.length === 1 && outer === 0) return "withdrawal";
    if (stack.length === 2 && outer === 1) return inner === 0 ? "clawback" : "escape";
    return null;
  };
  return ops.map((op) => {
    if (op.kind === "op" && (op.opcode === OP_IF || op.opcode === OP_NOTIF)) {
      stack.push(0);
      notifs.push(op.opcode === OP_NOTIF);
      if (op.opcode === OP_NOTIF) inverted += 1;
      return pathOf();
    }
    if (op.kind === "op" && op.opcode === OP_ELSE && stack.length > 0) {
      stack[stack.length - 1] = 1;
      // The outer ELSE opens the inner IF that follows it: the Clawback Path.
      return stack.length === 1 && inverted === 0 ? "clawback" : pathOf();
    }
    if (op.kind === "op" && op.opcode === OP_ENDIF && stack.length > 0) {
      stack.pop();
      if (notifs.pop()) inverted -= 1;
      return null;
    }
    return pathOf();
  });
}
