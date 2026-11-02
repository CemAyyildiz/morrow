import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  bytesToHex,
  hexToBytes,
  ownerSignature,
  type BitcoinBackend,
  type Hex,
  type Utxo,
} from "@morrow/core-ts";
import { address as baddress, networks, payments, Transaction } from "bitcoinjs-lib";

/** Challenge rounds are signet only; bitcoinjs uses its testnet parameters (tb1) for signet. */
const SIGNET = networks.testnet;
export const DUST_LIMIT_SATS = 546n;
/** Opt-in RBF, so a stuck funding transaction can be fee-bumped by hand. */
const RBF_SEQUENCE = 0xfffffffd;

export class RecoveryWalletError extends Error {
  constructor(
    readonly code: "RECOVERY_BALANCE_SHORT" | "ALLOWANCE_ADDRESS" | "NOT_VAULT_ADDRESS",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RecoveryWalletError";
  }
}

/**
 * Upper-bound vsize of a P2WPKH spend paying one P2WSH output (the Vault Address) and an optional
 * P2WPKH change output. Signatures are counted at their 72-byte maximum.
 */
export function fundingVsize(inputs: number, change: boolean): number {
  const base = 10 + 41 * inputs + 43 + (change ? 31 : 0);
  const witness = 2 + 108 * inputs;
  return Math.ceil((base * 4 + witness) / 4);
}

export interface FundingPlan {
  inputs: Utxo[];
  amount_sats: bigint;
  fee_sats: bigint;
  /** 0 when the leftover is dust and goes to the fee instead. */
  change_sats: bigint;
}

/** Largest coins first, until the amount and the fee are covered. */
export function planFunding(utxos: Utxo[], amountSats: bigint, feeRate: number): FundingPlan {
  if (amountSats < DUST_LIMIT_SATS) {
    throw new RangeError(`Funding amount ${amountSats} is below the dust limit`);
  }
  const rate = BigInt(feeRate);
  const sorted = [...utxos].sort((a, b) => Number(BigInt(b.value_sats) - BigInt(a.value_sats)));
  const inputs: Utxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    inputs.push(utxo);
    total += BigInt(utxo.value_sats);
    const withChange = BigInt(fundingVsize(inputs.length, true)) * rate;
    if (total >= amountSats + withChange + DUST_LIMIT_SATS) {
      return {
        inputs,
        amount_sats: amountSats,
        fee_sats: withChange,
        change_sats: total - amountSats - withChange,
      };
    }
    const withoutChange = BigInt(fundingVsize(inputs.length, false)) * rate;
    if (total >= amountSats + withoutChange) {
      return { inputs, amount_sats: amountSats, fee_sats: total - amountSats, change_sats: 0n };
    }
  }
  const need = amountSats + BigInt(fundingVsize(Math.max(1, sorted.length), false)) * rate;
  throw new RecoveryWalletError(
    "RECOVERY_BALANCE_SHORT",
    `spendable ${total} sats, need ${need} sats (${amountSats} + fee at ${feeRate} sat/vB)`,
  );
}

/** The Vault's two P2WSH addresses; only `vault` may ever be funded. */
export interface VaultAddresses {
  vault: string;
  allowance: string;
}

/** Throws unless `destination` is exactly the Vault Address; the Allowance Address is never funded. */
export function assertVaultAddress(destination: string, addresses: VaultAddresses): void {
  if (destination.toLowerCase() === addresses.allowance.toLowerCase()) {
    throw new RecoveryWalletError("ALLOWANCE_ADDRESS", `refusing to fund ${destination}`);
  }
  if (destination !== addresses.vault) {
    throw new RecoveryWalletError("NOT_VAULT_ADDRESS", `${destination} is not the Vault Address`);
  }
}

export interface SignedFunding {
  rawHex: Hex;
  txid: Hex;
  plan: FundingPlan;
}

/**
 * The operator's signet Recovery Address: a P2WPKH hot key held only by `tools/challenge`. It
 * receives every Clawback and funds every round. The secret is never logged or served.
 */
export class RecoveryWallet {
  readonly address: string;
  private readonly secretKey: Uint8Array;
  private readonly publicKey: Uint8Array;
  private readonly output: Uint8Array;
  private readonly scriptCode: Uint8Array;

  constructor(
    secretKeyHex: string,
    private readonly backend: BitcoinBackend,
    private readonly feeRate: number,
  ) {
    this.secretKey = hexToBytes(secretKeyHex.toLowerCase());
    this.publicKey = secp256k1.getPublicKey(this.secretKey, true);
    const p2wpkh = payments.p2wpkh({ pubkey: this.publicKey, network: SIGNET });
    if (!p2wpkh.address || !p2wpkh.output || !p2wpkh.hash) {
      throw new Error("Could not derive the Recovery Address");
    }
    this.address = p2wpkh.address;
    this.output = p2wpkh.output;
    const p2pkh = payments.p2pkh({ hash: p2wpkh.hash, network: SIGNET });
    if (!p2pkh.output) throw new Error("Could not derive the P2WPKH script code");
    this.scriptCode = p2pkh.output;
  }

  /** Confirmed coins only: an unconfirmed coin could still be replaced. */
  async spendable(): Promise<Utxo[]> {
    return (await this.backend.getUtxos(this.address)).filter((u) => u.height !== null);
  }

  /** Throws `RECOVERY_BALANCE_SHORT` unless the spendable coins cover the amount and the fee. */
  async plan(amountSats: bigint): Promise<FundingPlan> {
    return planFunding(await this.spendable(), amountSats, this.feeRate);
  }

  /** Builds and signs the funding transaction without broadcasting it. */
  sign(destination: string, addresses: VaultAddresses, plan: FundingPlan): SignedFunding {
    assertVaultAddress(destination, addresses);
    const tx = new Transaction();
    tx.version = 2;
    for (const utxo of plan.inputs) {
      tx.addInput(hexToBytes(utxo.txid).reverse(), utxo.vout, RBF_SEQUENCE);
    }
    tx.addOutput(baddress.toOutputScript(destination, SIGNET), plan.amount_sats);
    if (plan.change_sats > 0n) tx.addOutput(this.output, plan.change_sats);
    plan.inputs.forEach((utxo, i) => {
      const sighash = tx.hashForWitnessV0(
        i,
        this.scriptCode,
        BigInt(utxo.value_sats),
        Transaction.SIGHASH_ALL,
      );
      tx.setWitness(i, [
        hexToBytes(ownerSignature(bytesToHex(sighash), this.secretKey)),
        this.publicKey,
      ]);
    });
    return { rawHex: tx.toHex(), txid: tx.getId(), plan };
  }

  /**
   * Plans and signs a payment of `amountSats` to the Vault Address, without broadcasting it, so
   * the txid can be recorded first. Refuses any other address.
   */
  async prepare(
    destination: string,
    addresses: VaultAddresses,
    amountSats: bigint,
  ): Promise<SignedFunding> {
    assertVaultAddress(destination, addresses);
    return this.sign(destination, addresses, await this.plan(amountSats));
  }

  /**
   * Broadcasts a signed funding transaction and returns its txid. A broadcast error for a
   * transaction the backend already knows (it reached the network) counts as success.
   */
  async broadcast(signed: SignedFunding): Promise<Hex> {
    try {
      await this.backend.broadcast(signed.rawHex);
    } catch (error) {
      const known = await this.backend.getTx(signed.txid).catch(() => null);
      if (!known) throw error;
    }
    return signed.txid;
  }
}
