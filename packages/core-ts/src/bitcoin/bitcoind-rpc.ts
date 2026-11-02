import type { Hex } from "../contract/types.js";
import {
  BitcoinBackendError,
  btcToSats,
  type BitcoinBackend,
  type Spender,
  type TxStatus,
  type Utxo,
} from "./backend.js";

type Fetch = typeof fetch;

interface RpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
}

/** Bitcoin Core JSON-RPC client. `url` may carry credentials: http://user:pass@host:port. */
export class BitcoindRpc implements BitcoinBackend {
  private readonly endpoint: string;
  private readonly authorization: string | null;
  private nextId = 1;

  constructor(
    url: string,
    private readonly fetchFn: Fetch = fetch,
  ) {
    const parsed = new URL(url);
    this.authorization = parsed.username
      ? `Basic ${btoa(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`)}`
      : null;
    parsed.username = "";
    parsed.password = "";
    this.endpoint = parsed.toString();
  }

  /** Calls any RPC method; `wallet` targets /wallet/<name>. */
  async call<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    const url = wallet
      ? new URL(`wallet/${encodeURIComponent(wallet)}`, this.endpoint).toString()
      : this.endpoint;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.authorization) headers.authorization = this.authorization;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: this.nextId++, method, params }),
    });
    const body = (await response.json().catch(() => null)) as RpcResponse<T> | null;
    if (body?.error)
      throw new BitcoinBackendError(`${method}: ${body.error.message}`, response.status);
    if (!response.ok || !body)
      throw new BitcoinBackendError(`${method}: HTTP ${response.status}`, response.status);
    return body.result as T;
  }

  /** Confirmed UTXOs only: `scantxoutset` reads the UTXO set, not the mempool. */
  async getUtxos(address: string): Promise<Utxo[]> {
    const scan = await this.call<{
      unspents: { txid: string; vout: number; amount: number; height: number }[];
    }>("scantxoutset", ["start", [`addr(${address})`]]);
    return scan.unspents.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value_sats: btcToSats(u.amount),
      height: u.height,
    }));
  }

  async getTipHeight(): Promise<number> {
    return this.call<number>("getblockcount");
  }

  async getTx(txid: Hex): Promise<TxStatus | null> {
    try {
      const tx = await this.call<{ txid: string; confirmations?: number; blockhash?: string }>(
        "getrawtransaction",
        [txid, 1],
      );
      const confirmations = tx.confirmations ?? 0;
      const tip = confirmations > 0 ? await this.getTipHeight() : 0;
      return {
        txid: tx.txid,
        confirmations,
        block_height: confirmations > 0 ? tip - confirmations + 1 : null,
      };
    } catch (error) {
      if (
        error instanceof BitcoinBackendError &&
        /No such mempool or blockchain transaction/.test(error.message)
      ) {
        return null;
      }
      throw error;
    }
  }

  async broadcast(rawHex: Hex): Promise<Hex> {
    return this.call<string>("sendrawtransaction", [rawHex]);
  }

  /** `gettxspendingprevout` (mempool only) then `getmempoolentry` for the fee and descendant fees. */
  async getSpender(outpoint: { txid: Hex; vout: number }): Promise<Spender | null> {
    const [result] = await this.call<{ spendingtxid?: string; blockhash?: string }[]>(
      "gettxspendingprevout",
      [[{ txid: outpoint.txid, vout: outpoint.vout }]],
    );
    const spending = result?.spendingtxid;
    if (!spending || result.blockhash) return null;
    let entry: {
      vsize: number;
      vsize_bip141?: number;
      fees: { base: number; descendant: number };
    };
    try {
      entry = await this.call<typeof entry>("getmempoolentry", [spending]);
    } catch (error) {
      // The spender left the mempool between the two calls.
      if (error instanceof BitcoinBackendError && /not in mempool/i.test(error.message)) {
        return null;
      }
      throw error;
    }
    const fee = btcToSats(entry.fees.base);
    return {
      txid: spending,
      fee_rate_sat_vb: Number(fee) / (entry.vsize_bip141 ?? entry.vsize),
      fee_sats: fee,
      descendant_fees_sats: btcToSats(entry.fees.descendant),
    };
  }
}
