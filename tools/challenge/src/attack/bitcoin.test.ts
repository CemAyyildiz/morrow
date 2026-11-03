import { secp256k1 } from "@noble/curves/secp256k1.js";
import { WITNESS_TEMPLATES, type Outpoint, type VaultKit } from "@morrow/core-ts";
import { networks, opcodes, payments, script as bscript, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { buildOwnerSpend, signDer } from "./bitcoin.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The contract's three-path Vault Script, built independently with bitcoinjs-lib. */
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

function fixture(network: "regtest" | "signet" = "regtest", timelock = 6) {
  const ownerSecret = secp256k1.utils.randomSecretKey();
  const key = () => secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true);
  const owner = secp256k1.getPublicKey(ownerSecret, true);
  const script = vaultScript(owner, key(), key(), timelock);
  const net = network === "regtest" ? networks.regtest : networks.testnet;
  const vaultAddress = payments.p2wsh({ redeem: { output: script }, network: net }).address ?? "";
  const kit: VaultKit = {
    kit_version: 1,
    btc_network: network,
    vault_script_hex: hex(script),
    allowance_script_hex: hex(script),
    addresses: { vault: vaultAddress, allowance: vaultAddress },
    escape_timelock_blocks: timelock,
    cosigner_pubkeys: { vault: hex(key()), allowance: hex(key()) },
    witness_templates: WITNESS_TEMPLATES,
  };
  return { kit, ownerSecret, script, owner };
}

const coins: Outpoint[] = [{ txid: "ab".repeat(32), vout: 0, value_sats: "100000" }];
const DEST_REGTEST = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

describe("signDer", () => {
  it("produces a low-S DER signature with SIGHASH_ALL", () => {
    const secret = secp256k1.utils.randomSecretKey();
    const sighash = new Uint8Array(32).fill(7);
    const sig = signDer(sighash, secret);
    expect(sig[0]).toBe(0x30); // DER sequence
    expect(sig[sig.length - 1]).toBe(Transaction.SIGHASH_ALL);
    // DER without the trailing sighash byte verifies against the public key.
    const der = sig.subarray(0, sig.length - 1);
    const pub = secp256k1.getPublicKey(secret, true);
    expect(secp256k1.verify(der, sighash, pub, { prehash: false, format: "der" })).toBe(true);
  });
});

describe("buildOwnerSpend (escape path)", () => {
  it("sets nSequence to the Escape Timelock and fills the escape witness", () => {
    const { kit, ownerSecret, script } = fixture("regtest", 6);
    const spend = buildOwnerSpend({
      kit,
      coins,
      ownerSecretKey: ownerSecret,
      destination: DEST_REGTEST,
      feeRateSatVb: 2,
      path: "escape",
    });
    const tx = Transaction.fromHex(spend.rawHex);
    expect(tx.ins[0]?.sequence).toBe(6);
    const witness = tx.ins[0]?.witness ?? [];
    // escape template: [owner sig, empty, empty, script]
    expect(witness).toHaveLength(4);
    expect(witness[0]?.length).toBeGreaterThan(0);
    expect(witness[1]?.length).toBe(0);
    expect(witness[2]?.length).toBe(0);
    expect(hex(witness[3] as Uint8Array)).toBe(hex(script));
  });
});

describe("buildOwnerSpend (withdrawal path without a co-signer)", () => {
  it("leaves the Co-signer slot empty and RBF-signals", () => {
    const { kit, ownerSecret, script } = fixture("regtest", 6);
    const spend = buildOwnerSpend({
      kit,
      coins,
      ownerSecretKey: ownerSecret,
      destination: DEST_REGTEST,
      feeRateSatVb: 2,
      path: "no_cosigner",
    });
    const tx = Transaction.fromHex(spend.rawHex);
    expect(tx.ins[0]?.sequence).toBe(0xfffffffd);
    const witness = tx.ins[0]?.witness ?? [];
    // withdrawal template: [cosigner sig, owner sig, selector 01, script]
    expect(witness).toHaveLength(4);
    expect(witness[0]?.length).toBe(0); // the missing Co-signer signature
    expect(witness[1]?.length).toBeGreaterThan(0); // the Owner signature
    expect(hex(witness[2] as Uint8Array)).toBe("01");
    expect(hex(witness[3] as Uint8Array)).toBe(hex(script));
  });
});

// Integration: a live regtest node must reject both Owner-Key-only spends.
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

describe.skipIf(!url)("a regtest node rejects Owner-Key-only spends", () => {
  it("refuses the Escape spend before maturity and the no-co-signer spend", async () => {
    const { kit, ownerSecret } = fixture("regtest", 6);
    const miner = await rpc<string>("getnewaddress", [], "miner");
    await rpc("sendtoaddress", [kit.addresses.vault, "0.01"], "miner");
    await rpc("generatetoaddress", [1, miner]);
    const scan = await rpc<{ unspents: { txid: string; vout: number; amount: number }[] }>(
      "scantxoutset",
      ["start", [`addr(${kit.addresses.vault})`]],
    );
    const unspent = scan.unspents[0];
    if (!unspent) throw new Error("funding UTXO not found");
    const vaultCoins: Outpoint[] = [
      { txid: unspent.txid, vout: unspent.vout, value_sats: "1000000" },
    ];
    const destination = await rpc<string>("getnewaddress", [], "miner");

    const escape = buildOwnerSpend({
      kit,
      coins: vaultCoins,
      ownerSecretKey: ownerSecret,
      destination,
      feeRateSatVb: 2,
      path: "escape",
    });
    await expect(rpc("sendrawtransaction", [escape.rawHex])).rejects.toThrow(/non-BIP68-final/);

    const noCosigner = buildOwnerSpend({
      kit,
      coins: vaultCoins,
      ownerSecretKey: ownerSecret,
      destination,
      feeRateSatVb: 2,
      path: "no_cosigner",
    });
    await expect(rpc("sendrawtransaction", [noCosigner.rawHex])).rejects.toThrow(
      /script|mandatory|signature/i,
    );
  });
});
