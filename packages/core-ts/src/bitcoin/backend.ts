import type { Hex, U64 } from "../contract/types.js";

export interface Utxo {
  /** Display (RPC) byte order. */
  txid: Hex;
  vout: number;
  value_sats: U64;
  /** Block height, or null while unconfirmed. */
  height: number | null;
}

export interface TxStatus {
  txid: Hex;
  /** 0 while in the mempool. */
  confirmations: number;
  block_height: number | null;
}

/** The only way Morrow components read or broadcast Bitcoin data. */
export interface BitcoinBackend {
  getUtxos(address: string): Promise<Utxo[]>;
  getTipHeight(): Promise<number>;
  /** Null if the backend does not know the transaction. */
  getTx(txid: Hex): Promise<TxStatus | null>;
  /** Returns the txid. */
  broadcast(rawHex: Hex): Promise<Hex>;
}

export class BitcoinBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BitcoinBackendError";
  }
}

const SATS_PER_BTC = 100_000_000n;

/** Converts a BTC decimal (as bitcoind returns it) to sats without floating-point drift. */
export function btcToSats(btc: number | string): U64 {
  const text = typeof btc === "number" ? btc.toFixed(8) : btc;
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new BitcoinBackendError(`Invalid BTC amount: ${text}`);
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(8, "0"));
  return (whole * SATS_PER_BTC + fraction).toString();
}
