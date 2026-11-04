import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { opcodes, script as bscript } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import type { BtcNetwork } from "../contract/types.js";
import { recomputeAddress } from "../crypto/address.js";
import {
  compareScripts,
  decodeScript,
  encodeScriptNumber,
  opcodeName,
  p2wshAddress,
  sameOp,
  scriptNumber,
  scriptPaths,
  vaultScriptTemplate,
  type ScriptOp,
} from "./browser-script.js";

const key = (prefix: string, byte: string) => `${prefix}${byte.repeat(32)}`;
const OWNER = key("02", "11");
const COSIGNER = key("03", "aa");
const GUARDIANS = [key("02", "22"), key("02", "33"), key("02", "44")];

// contracts/vault/src/core/script.rs tests: bytes and addresses computed with bitcoinjs-lib.
const THREE_GUARDIANS =
  "6321021111111111111111111111111111111111111111111111111111111111111111ad2103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac67632103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad5121022222222222222222222222222222222222222222222222222222222222222222210233333333333333333333333333333333333333333333333333333333333333332102444444444444444444444444444444444444444444444444444444444444444453ae6702a866b27521021111111111111111111111111111111111111111111111111111111111111111ac6868";
const ONE_GUARDIAN_REGTEST =
  "6321021111111111111111111111111111111111111111111111111111111111111111ad2103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac67632103aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad512102222222222222222222222222222222222222222222222222222222222222222251ae6756b27521021111111111111111111111111111111111111111111111111111111111111111ac6868";

const NETWORKS: BtcNetwork[] = ["signet", "testnet4", "regtest", "bitcoin"];
const HRP: Record<BtcNetwork, string> = {
  signet: "tb",
  testnet4: "tb",
  regtest: "bcrt",
  bitcoin: "bc",
};

/** bitcoinjs-lib's opcode names by number, the first of its aliases (an enum: skip the reverse map). */
const BITCOINJS_NAMES = new Map<number, string>();
for (const [name, code] of Object.entries(opcodes)) {
  if (typeof code === "number" && !BITCOINJS_NAMES.has(code)) BITCOINJS_NAMES.set(code, name);
}

/** Our decoding in bitcoinjs-lib's `decompile` terms: an opcode number or the pushed bytes. */
const asChunks = (ops: ScriptOp[]) =>
  ops.map((op) => (op.kind === "push" ? bytesToHex(op.data) : op.opcode));

describe("p2wshAddress", () => {
  it("matches the contract's vectors", () => {
    expect(p2wshAddress(hexToBytes(THREE_GUARDIANS), "signet")).toBe(
      "tb1qjzz9rvff0n247nl76zcwwylrjkej02l4pa8l5he6zzyn9kagp3aq2u9zku",
    );
    expect(p2wshAddress(hexToBytes(THREE_GUARDIANS), "bitcoin")).toBe(
      "bc1qjzz9rvff0n247nl76zcwwylrjkej02l4pa8l5he6zzyn9kagp3aqa5ndvn",
    );
    expect(p2wshAddress(hexToBytes(ONE_GUARDIAN_REGTEST), "regtest")).toBe(
      "bcrt1q7sx62zjs49gr9eklsszt4smasje2aa3ppkyuqcmd5aqnvuaavgwsxspak7",
    );
  });

  it("matches the BIP173 P2WSH vector", () => {
    const script = hexToBytes(
      "210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
    );
    expect(p2wshAddress(script, "signet")).toBe(
      "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
    );
    expect(p2wshAddress(script, "bitcoin")).toBe(
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    );
  });

  it.each(NETWORKS)("matches bitcoinjs-lib payments.p2wsh on %s, with its HRP", (network) => {
    for (const hex of [THREE_GUARDIANS, ONE_GUARDIAN_REGTEST, "51", "00".repeat(300)]) {
      const address = p2wshAddress(hexToBytes(hex), network);
      expect(address).toBe(recomputeAddress(hex, network));
      expect(address.startsWith(`${HRP[network]}1q`)).toBe(true);
    }
  });

  it("changes when one byte changes", () => {
    const script = hexToBytes(THREE_GUARDIANS);
    const flipped = script.slice();
    flipped[34] = (flipped[34] as number) ^ 0x01;
    expect(p2wshAddress(flipped, "signet")).not.toBe(p2wshAddress(script, "signet"));
    expect(p2wshAddress(flipped, "signet")).toBe(recomputeAddress(bytesToHex(flipped), "signet"));
  });
});

describe("vaultScriptTemplate", () => {
  it("rebuilds the contract's three-Guardian script byte for byte", () => {
    const { script } = vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS, 26_280);
    expect(bytesToHex(script)).toBe(THREE_GUARDIANS);
  });

  it("pushes a small timelock as OP_N, as the contract does", () => {
    const { script } = vaultScriptTemplate(OWNER, COSIGNER, [GUARDIANS[0] as string], 6);
    expect(bytesToHex(script)).toBe(ONE_GUARDIAN_REGTEST);
  });

  it("labels every element with its role and path", () => {
    const { elements } = vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS.slice(0, 2), 26_280);
    expect(elements.map((e) => [e.op.name, e.role, e.path, e.guardian])).toEqual([
      ["OP_IF", "branch", "withdrawal", undefined],
      ["OP_PUSHBYTES_33", "owner_key", "withdrawal", undefined],
      ["OP_CHECKSIGVERIFY", "opcode", "withdrawal", undefined],
      ["OP_PUSHBYTES_33", "cosigner_key", "withdrawal", undefined],
      ["OP_CHECKSIG", "opcode", "withdrawal", undefined],
      ["OP_ELSE", "branch", "clawback", undefined],
      ["OP_IF", "branch", "clawback", undefined],
      ["OP_PUSHBYTES_33", "cosigner_key", "clawback", undefined],
      ["OP_CHECKSIGVERIFY", "opcode", "clawback", undefined],
      ["OP_1", "threshold", "clawback", undefined],
      ["OP_PUSHBYTES_33", "guardian_key", "clawback", 0],
      ["OP_PUSHBYTES_33", "guardian_key", "clawback", 1],
      ["OP_2", "guardian_count", "clawback", undefined],
      ["OP_CHECKMULTISIG", "opcode", "clawback", undefined],
      ["OP_ELSE", "branch", "escape", undefined],
      ["OP_PUSHBYTES_2", "timelock", "escape", undefined],
      ["OP_CHECKSEQUENCEVERIFY", "opcode", "escape", undefined],
      ["OP_DROP", "opcode", "escape", undefined],
      ["OP_PUSHBYTES_33", "owner_key", "escape", undefined],
      ["OP_CHECKSIG", "opcode", "escape", undefined],
      ["OP_ENDIF", "branch", null, undefined],
      ["OP_ENDIF", "branch", null, undefined],
    ]);
    // Element offsets tile the script.
    let at = 0;
    for (const { op } of elements) {
      expect(op.offset).toBe(at);
      at += op.size;
    }
  });

  it("takes keys as bytes too, and refuses a push no key can be", () => {
    const { script } = vaultScriptTemplate(
      hexToBytes(OWNER),
      hexToBytes(COSIGNER),
      GUARDIANS.map((k) => hexToBytes(k)),
      26_280,
    );
    expect(bytesToHex(script)).toBe(THREE_GUARDIANS);
    expect(() => vaultScriptTemplate("", COSIGNER, GUARDIANS, 6)).toThrow(RangeError);
    expect(() => vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS, -1)).toThrow(RangeError);
  });
});

describe("decodeScript", () => {
  it("decodes the Vault Script as bitcoinjs-lib decompiles it", () => {
    for (const hex of [THREE_GUARDIANS, ONE_GUARDIAN_REGTEST]) {
      const ops = decodeScript(hexToBytes(hex));
      const theirs = (bscript.decompile(Buffer.from(hex, "hex")) ?? []).map((chunk) =>
        typeof chunk === "number" ? chunk : bytesToHex(chunk),
      );
      expect(asChunks(ops)).toEqual(theirs);
    }
  });

  it("names opcodes as bitcoinjs-lib does", () => {
    for (let code = 0; code < 256; code++) {
      const theirs = BITCOINJS_NAMES.get(code);
      if (theirs === undefined || (code >= 0x01 && code <= 0x4b)) continue;
      // OP_PUBKEYHASH and OP_PUBKEY are bitcoinjs-lib's template placeholders, not opcodes:
      // Bitcoin Core calls 0xfd and 0xfe unknown.
      if (code === 0xfd || code === 0xfe) {
        expect(opcodeName(code)).toMatch(/^OP_UNKNOWN_0xf[de]$/);
        continue;
      }
      // bitcoinjs-lib lists OP_FALSE/OP_TRUE and OP_NOP2/3 first; Bitcoin Core names them so.
      const alias: Record<string, string> = {
        OP_FALSE: "OP_0",
        OP_TRUE: "OP_1",
        OP_NOP2: "OP_CHECKLOCKTIMEVERIFY",
        OP_NOP3: "OP_CHECKSEQUENCEVERIFY",
      };
      expect(opcodeName(code)).toBe(alias[theirs] ?? theirs);
    }
    expect(opcodeName(0x21)).toBe("OP_PUSHBYTES_33");
    expect(opcodeName(0xbb)).toBe("OP_UNKNOWN_0xbb");
  });

  it("gives every element its byte offset and size", () => {
    const ops = decodeScript(hexToBytes(THREE_GUARDIANS));
    expect(ops[0]).toMatchObject({ kind: "op", offset: 0, size: 1, name: "OP_IF" });
    expect(ops[1]).toMatchObject({ kind: "push", offset: 1, size: 34, opcode: 0x21 });
    expect(ops[2]).toMatchObject({ kind: "op", offset: 35, name: "OP_CHECKSIGVERIFY" });
    const timelock = ops.find((op) => op.kind === "push" && op.size === 3);
    expect(timelock && scriptNumber(timelock)).toBe(26_280);
  });

  it("reads PUSHDATA1/2/4 and marks a push that runs past the end", () => {
    const ops = decodeScript(hexToBytes(`4c02abcd4d0100ff4e01000000ee00`));
    expect(ops.map((op) => [op.kind, op.offset, op.size])).toEqual([
      ["push", 0, 4],
      ["push", 4, 4],
      ["push", 8, 6],
      ["op", 14, 1],
    ]);
    expect(decodeScript(hexToBytes("21aabb"))).toEqual([
      { kind: "truncated", offset: 0, size: 3, opcode: 0x21, name: "OP_PUSHBYTES_33" },
    ]);
    expect(decodeScript(hexToBytes("ac4d01"))).toMatchObject([
      { kind: "op" },
      { kind: "truncated", offset: 1, size: 2 },
    ]);
    expect(decodeScript(new Uint8Array())).toEqual([]);
  });
});

describe("script numbers", () => {
  it("encodes minimally, as the contract's push_number", () => {
    const hex = (n: number) => bytesToHex(encodeScriptNumber(n));
    expect(hex(0)).toBe("00");
    expect(hex(1)).toBe("51");
    expect(hex(16)).toBe("60");
    expect(hex(17)).toBe("0111");
    expect(hex(128)).toBe("028000");
    expect(hex(4_320)).toBe("02e010");
    expect(hex(26_280)).toBe("02a866");
    expect(hex(65_535)).toBe("03ffff00");
    expect(() => encodeScriptNumber(1.5)).toThrow(RangeError);
  });

  it("round-trips through decodeScript, matching bitcoinjs-lib's number encoding", () => {
    for (const n of [0, 1, 6, 16, 17, 127, 128, 255, 256, 4_320, 26_280, 32_767, 65_535, 1e6]) {
      const [op] = decodeScript(encodeScriptNumber(n));
      expect(op && scriptNumber(op)).toBe(n);
      if (n > 16) {
        expect(op?.kind === "push" && bytesToHex(op.data)).toBe(
          bytesToHex(bscript.number.encode(n)),
        );
      }
    }
  });

  it("reads negative and non-numeric elements", () => {
    const [negative] = decodeScript(hexToBytes("0181"));
    expect(negative && scriptNumber(negative)).toBe(-1);
    const [minusOne] = decodeScript(hexToBytes("4f"));
    expect(minusOne && scriptNumber(minusOne)).toBe(-1);
    const [checksig] = decodeScript(hexToBytes("ac"));
    expect(checksig && scriptNumber(checksig)).toBeNull();
    const [wide] = decodeScript(hexToBytes(`05${"01".repeat(5)}`));
    expect(wide && scriptNumber(wide)).toBeNull();
  });
});

describe("compareScripts", () => {
  const template = vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS, 26_280);
  const ops = template.elements.map((e) => e.op);

  it("finds no difference between the contract's script and the template", () => {
    expect(compareScripts(decodeScript(hexToBytes(THREE_GUARDIANS)), ops)).toBeNull();
  });

  it("names the first differing element: a flipped byte of the Owner key", () => {
    const flipped = hexToBytes(THREE_GUARDIANS);
    flipped[34] = (flipped[34] as number) ^ 0x01;
    const difference = compareScripts(decodeScript(flipped), ops);
    expect(difference?.index).toBe(1);
    expect(template.elements[1]?.role).toBe("owner_key");
  });

  it("another Owner key differs at the first Owner key push", () => {
    const other = vaultScriptTemplate(key("03", "99"), COSIGNER, GUARDIANS, 26_280);
    const difference = compareScripts(decodeScript(other.script), ops);
    expect(difference?.index).toBe(1);
  });

  it("another timelock or Guardian order differs at that element", () => {
    const later = vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS, 26_281);
    expect(compareScripts(decodeScript(later.script), ops)?.index).toBe(16);
    const swapped = vaultScriptTemplate(OWNER, COSIGNER, [...GUARDIANS].reverse(), 26_280);
    expect(compareScripts(decodeScript(swapped.script), ops)?.index).toBe(10);
  });

  it("a shorter or longer script differs where one ends", () => {
    const short = decodeScript(hexToBytes(THREE_GUARDIANS.slice(0, -2)));
    expect(compareScripts(short, ops)).toMatchObject({ index: ops.length - 1, actual: null });
    const long = decodeScript(hexToBytes(`${THREE_GUARDIANS}ac`));
    expect(compareScripts(long, ops)).toMatchObject({ index: ops.length, expected: null });
  });

  it("compares elements by their bytes", () => {
    const [a, b] = decodeScript(hexToBytes("0101" + "0102"));
    expect(a && b && sameOp(a, b)).toBe(false);
    const [c, d] = decodeScript(hexToBytes("ac" + "ac"));
    expect(c && d && sameOp(c, d)).toBe(true);
  });
});

describe("scriptPaths", () => {
  it("reads the three paths from the IF / ELSE structure", () => {
    const ops = decodeScript(hexToBytes(THREE_GUARDIANS));
    const template = vaultScriptTemplate(OWNER, COSIGNER, GUARDIANS, 26_280);
    expect(scriptPaths(ops)).toEqual(template.elements.map((e) => e.path));
  });

  it("puts anything outside the Vault Script's branches on no path", () => {
    expect(scriptPaths(decodeScript(hexToBytes("ac6368")))).toEqual([null, "withdrawal", null]);
    // A third level of IF is no path of the Vault Script.
    expect(scriptPaths(decodeScript(hexToBytes("636763ac636868")))).toEqual([
      "withdrawal",
      "clawback",
      "clawback",
      "clawback",
      null,
      null,
      null,
    ]);
  });
});
