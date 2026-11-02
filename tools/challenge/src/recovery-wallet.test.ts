import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@morrow/core-ts";
import { address as baddress, networks, payments, script, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import {
  DUST_LIMIT_SATS,
  RecoveryWallet,
  RecoveryWalletError,
  fundingVsize,
  planFunding,
} from "./recovery-wallet.js";
import { FakeBackend, RECOVERY_SECRET, p2wshAddress, txid } from "./test-helpers.js";

const VAULT = { vault: p2wshAddress(1), allowance: p2wshAddress(2) };
const utxo = (n: number, value: number, height: number | null = 200) => ({
  txid: txid(n),
  vout: 0,
  value_sats: String(value),
  height,
});

describe("planFunding", () => {
  it("adds change back to the Recovery Address when it is above dust", () => {
    const plan = planFunding([utxo(1, 50_000), utxo(2, 200_000)], 100_000n, 2);
    expect(plan.inputs.map((u) => u.txid)).toEqual([txid(2)]);
    const fee = BigInt(fundingVsize(1, true) * 2);
    expect(plan).toMatchObject({
      amount_sats: 100_000n,
      fee_sats: fee,
      change_sats: 100_000n - fee,
    });
  });

  it("drops dust change into the fee", () => {
    const fee = BigInt(fundingVsize(1, false) * 2);
    const plan = planFunding([utxo(1, Number(100_000n + fee + 100n))], 100_000n, 2);
    expect(plan.change_sats).toBe(0n);
    expect(plan.fee_sats).toBe(fee + 100n);
  });

  it("refuses when the coins do not cover amount + fee", () => {
    expect(() => planFunding([utxo(1, 100_000)], 100_000n, 2)).toThrow(/RECOVERY_BALANCE_SHORT/);
    expect(() => planFunding([], 100_000n, 2)).toThrow(RecoveryWalletError);
    expect(() => planFunding([utxo(1, 10_000)], DUST_LIMIT_SATS - 1n, 2)).toThrow(/dust/);
  });
});

describe("RecoveryWallet", () => {
  it("derives a signet P2WPKH address from the Recovery key", () => {
    const backend = new FakeBackend();
    const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
    const expected = payments.p2wpkh({
      pubkey: secp256k1.getPublicKey(hexToBytes(RECOVERY_SECRET), true),
      network: networks.testnet,
    }).address;
    expect(wallet.address).toBe(expected);
    expect(wallet.address.startsWith("tb1q")).toBe(true);
  });

  it("spends only confirmed coins", async () => {
    const backend = new FakeBackend();
    const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
    backend.utxos.set(wallet.address, [utxo(1, 500_000, null), utxo(2, 50_000)]);
    await expect(wallet.plan(100_000n)).rejects.toThrow(/RECOVERY_BALANCE_SHORT/);
  });

  it("pays the Vault Address only, with valid low-S P2WPKH signatures", async () => {
    const backend = new FakeBackend();
    const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
    backend.utxos.set(wallet.address, [utxo(1, 80_000), utxo(2, 40_000)]);
    const signed = await wallet.prepare(VAULT.vault, VAULT, 100_000n);
    expect(backend.broadcasts).toEqual([]); // signing never broadcasts
    const id = await wallet.broadcast(signed);
    expect(id).toBe(signed.txid);
    expect(backend.broadcasts).toHaveLength(1);
    const tx = Transaction.fromHex(backend.broadcasts[0]!);
    expect(tx.getId()).toBe(id);
    expect(tx.ins).toHaveLength(2);
    expect(tx.ins.every((input) => input.sequence === 0xfffffffd)).toBe(true);
    const [pay, change] = tx.outs;
    expect(baddress.fromOutputScript(pay!.script, networks.testnet)).toBe(VAULT.vault);
    expect(pay!.value).toBe(100_000n);
    expect(baddress.fromOutputScript(change!.script, networks.testnet)).toBe(wallet.address);
    expect(tx.outs).toHaveLength(2);
    // The fee estimate is an upper bound on the real size.
    const fee = 120_000n - 100_000n - change!.value;
    expect(Number(fee) / tx.virtualSize()).toBeGreaterThanOrEqual(2);

    const pubkey = secp256k1.getPublicKey(hexToBytes(RECOVERY_SECRET), true);
    const scriptCode = payments.p2pkh({ pubkey, network: networks.testnet }).output!;
    const values = [80_000n, 40_000n];
    tx.ins.forEach((input, i) => {
      const [sig, key] = input.witness;
      expect(Buffer.from(key!).equals(Buffer.from(pubkey))).toBe(true);
      const decoded = script.signature.decode(Buffer.from(sig!));
      expect(decoded.hashType).toBe(Transaction.SIGHASH_ALL);
      const sighash = tx.hashForWitnessV0(i, scriptCode, values[i]!, Transaction.SIGHASH_ALL);
      expect(secp256k1.verify(decoded.signature, sighash, pubkey, { prehash: false })).toBe(true);
    });
  });

  it("refuses to fund an Allowance Address or any other address, before touching coins", async () => {
    const backend = new FakeBackend();
    const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
    backend.utxos.set(wallet.address, [utxo(1, 500_000)]);
    await expect(wallet.prepare(VAULT.allowance, VAULT, 100_000n)).rejects.toThrow(
      /ALLOWANCE_ADDRESS/,
    );
    await expect(wallet.prepare(p2wshAddress(9), VAULT, 100_000n)).rejects.toThrow(
      /NOT_VAULT_ADDRESS/,
    );
    const plan = await wallet.plan(100_000n);
    expect(() => wallet.sign(VAULT.allowance, VAULT, plan)).toThrow(/ALLOWANCE_ADDRESS/);
    expect(backend.broadcasts).toEqual([]);
  });

  it("treats a broadcast error for a transaction the network knows as success", async () => {
    const backend = new FakeBackend();
    const wallet = new RecoveryWallet(RECOVERY_SECRET, backend, 2);
    backend.utxos.set(wallet.address, [utxo(1, 500_000)]);
    const signed = await wallet.prepare(VAULT.vault, VAULT, 100_000n);
    backend.failBroadcast = "sent";
    expect(await wallet.broadcast(signed)).toBe(signed.txid);
    backend.failBroadcast = "lost";
    const other = await wallet.prepare(VAULT.vault, VAULT, 200_000n);
    await expect(wallet.broadcast(other)).rejects.toThrow("connection reset");
  });
});
