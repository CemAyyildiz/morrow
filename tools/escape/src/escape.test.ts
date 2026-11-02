import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { networks, opcodes, payments, script as bscript, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import {
  blocksRemaining,
  buildEscape,
  parseKit,
  type EscapeCoin,
  type VaultKit,
} from "./escape.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ESCAPE_TEMPLATE = [
  { kind: "signature", signer: "owner" },
  { kind: "empty" },
  { kind: "empty" },
  { kind: "script" },
] as const;

/** The contract's Vault Script shape, built independently. */
function vaultScript(
  owner: Uint8Array,
  cosigner: Uint8Array,
  guardian: Uint8Array,
  timelock: number,
) {
  return bscript.compile([
    opcodes.OP_IF,
    owner,
    opcodes.OP_CHECKSIGVERIFY,
    cosigner,
    opcodes.OP_CHECKSIG,
    opcodes.OP_ELSE,
    opcodes.OP_IF,
    cosigner,
    opcodes.OP_CHECKSIGVERIFY,
    opcodes.OP_1,
    guardian,
    opcodes.OP_1,
    opcodes.OP_CHECKMULTISIG,
    opcodes.OP_ELSE,
    bscript.number.encode(timelock),
    opcodes.OP_CHECKSEQUENCEVERIFY,
    opcodes.OP_DROP,
    owner,
    opcodes.OP_CHECKSIG,
    opcodes.OP_ENDIF,
    opcodes.OP_ENDIF,
  ]);
}

function fixture(timelock = 6) {
  const ownerSecret = secp256k1.utils.randomSecretKey();
  const key = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
  const owner = secp256k1.getPublicKey(ownerSecret, true);
  const vault = vaultScript(owner, key(), key(), timelock);
  const allowance = vaultScript(owner, key(), key(), timelock);
  const address = (s: Uint8Array) =>
    payments.p2wsh({ redeem: { output: s }, network: networks.regtest }).address ?? "";
  const kit: VaultKit = {
    kit_version: 1,
    btc_network: "regtest",
    vault_script_hex: hex(vault),
    allowance_script_hex: hex(allowance),
    addresses: { vault: address(vault), allowance: address(allowance) },
    escape_timelock_blocks: timelock,
    witness_templates: [{ path: "escape", slots: [...ESCAPE_TEMPLATE] }],
  };
  return { kit, ownerSecret, vault, allowance };
}

const coin = (height: number, source: "vault" | "allowance" = "vault"): EscapeCoin => ({
  txid: "ab".repeat(32),
  vout: 0,
  value_sats: 100_000n,
  height,
  source,
});
const DESTINATION = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

describe("escape", () => {
  it("counts blocks remaining per coin (CSV is relative to each coin)", () => {
    expect(blocksRemaining([coin(100)], 105, 6)).toBe(0);
    expect(blocksRemaining([coin(100)], 103, 6)).toBe(2);
    expect(blocksRemaining([coin(100), coin(104)], 105, 6)).toBe(4);
  });

  it("refuses before maturity with the blocks remaining", () => {
    const { kit, ownerSecret } = fixture();
    expect(() =>
      buildEscape({
        kit,
        coins: [coin(100)],
        ownerSecretKey: ownerSecret,
        destination: DESTINATION,
        feeRateSatVb: 2,
        tipHeight: 103,
      }),
    ).toThrow("2 blocks remaining");
  });

  it("builds a v2 transaction with nSequence = timelock and the Escape witness", () => {
    const { kit, ownerSecret, vault, allowance } = fixture(26_280);
    const result = buildEscape({
      kit,
      coins: [coin(1), { ...coin(1, "allowance"), txid: "cd".repeat(32) }],
      ownerSecretKey: ownerSecret,
      destination: DESTINATION,
      feeRateSatVb: 2,
      tipHeight: 30_000,
    });
    const tx = Transaction.fromHex(result.rawHex);
    expect(tx.version).toBe(2);
    expect(tx.ins.map((i) => i.sequence)).toEqual([26_280, 26_280]);
    expect(Buffer.from(tx.ins[0]!.hash).reverse().toString("hex")).toBe("ab".repeat(32));
    expect(tx.ins[0]!.witness.map((w) => w.length)).toEqual([
      tx.ins[0]!.witness[0]!.length,
      0,
      0,
      vault.length,
    ]);
    expect(hex(tx.ins[1]!.witness[3]!)).toBe(hex(allowance));
    expect(tx.outs).toHaveLength(1);
    expect(result.amount_sats + result.fee_sats).toBe(200_000n);
  });

  it("rejects kits it does not understand", () => {
    expect(() => parseKit(JSON.stringify({ kit_version: 2 }))).toThrow(/version/);
  });
});

describe("isolation", () => {
  it("depends only on standard Bitcoin libraries and nothing else in the repo", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@noble/curves", "bitcoinjs-lib"]);
    for (const file of ["escape.ts", "esplora.ts", "cli.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/from "@morrow\//);
    }
  });
});

const url = process.env.MORROW_REGTEST_RPC;

async function rpc<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const target = new URL(url ?? "");
  const auth = `Basic ${btoa(`${target.username}:${target.password}`)}`;
  target.username = "";
  target.password = "";
  const endpoint = wallet ? `${target.toString()}wallet/${wallet}` : target.toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result: T; error: { message: string } | null };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

describe.skipIf(!url)("escape accepted by Bitcoin Core (regtest)", () => {
  it("is non-final before the timelock and confirms after it", async () => {
    const { kit, ownerSecret } = fixture(6);
    const miner = await rpc<string>("getnewaddress", [], "miner");
    await rpc("sendtoaddress", [kit.addresses.vault, "0.01"], "miner");
    await rpc("generatetoaddress", [1, miner]);
    const scan = await rpc<{ unspents: { txid: string; vout: number; height: number }[] }>(
      "scantxoutset",
      ["start", [`addr(${kit.addresses.vault})`]],
    );
    const unspent = scan.unspents[0]!;
    const coins: EscapeCoin[] = [
      {
        txid: unspent.txid,
        vout: unspent.vout,
        value_sats: 1_000_000n,
        height: unspent.height,
        source: "vault",
      },
    ];
    const destination = await rpc<string>("getnewaddress", [], "miner");
    const request = { kit, coins, ownerSecretKey: ownerSecret, destination, feeRateSatVb: 2 };

    // The node rejects the CSV spend while the timelock is pending, even if we sign it anyway.
    const premature = buildEscape({ ...request, tipHeight: unspent.height + 5 });
    await expect(rpc("sendrawtransaction", [premature.rawHex])).rejects.toThrow(/non-BIP68-final/);

    await rpc("generatetoaddress", [5, miner]);
    const tip = await rpc<number>("getblockcount");
    const result = buildEscape({ ...request, tipHeight: tip });
    expect(await rpc<string>("sendrawtransaction", [result.rawHex])).toBe(result.txid);
    await rpc("generatetoaddress", [1, miner]);
    expect(
      (await rpc<{ confirmations: number }>("getrawtransaction", [result.txid, 1])).confirmations,
    ).toBeGreaterThanOrEqual(1);
  });
});
