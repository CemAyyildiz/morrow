import type { Hex } from "../contract/types.js";
import {
  BitcoinBackendError,
  type BitcoinBackend,
  type Spender,
  type TxStatus,
  type Utxo,
} from "./backend.js";

type Fetch = typeof fetch;

interface Outspend {
  spent: boolean;
  txid?: string;
  status?: { confirmed: boolean };
}

/** Bitcoin Core's default descendant limit: a deeper walk cannot be in one mempool package. */
const MAX_DESCENDANTS = 25;

/** Esplora REST client (mempool.space and compatible), e.g. https://mempool.space/signet/api. */
export class Esplora implements BitcoinBackend {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: Fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchFn(`${this.base}${path}`, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new BitcoinBackendError(
        `${path}: HTTP ${response.status} ${detail}`.trim(),
        response.status,
      );
    }
    return response;
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const utxos = (await (await this.request(`/address/${address}/utxo`)).json()) as {
      txid: string;
      vout: number;
      value: number;
      status: { confirmed: boolean; block_height?: number };
    }[];
    return utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value_sats: BigInt(u.value).toString(),
      height: u.status.confirmed ? (u.status.block_height ?? null) : null,
    }));
  }

  async getTipHeight(): Promise<number> {
    const text = await (await this.request("/blocks/tip/height")).text();
    const height = Number(text);
    if (!Number.isInteger(height)) throw new BitcoinBackendError(`Invalid tip height: ${text}`);
    return height;
  }

  async getTx(txid: Hex): Promise<TxStatus | null> {
    let status: { confirmed: boolean; block_height?: number };
    try {
      status = (await (await this.request(`/tx/${txid}/status`)).json()) as typeof status;
    } catch (error) {
      if (error instanceof BitcoinBackendError && error.status === 404) return null;
      throw error;
    }
    if (!status.confirmed || status.block_height === undefined) {
      return { txid, confirmations: 0, block_height: null };
    }
    const tip = await this.getTipHeight();
    return {
      txid,
      confirmations: tip - status.block_height + 1,
      block_height: status.block_height,
    };
  }

  async broadcast(rawHex: Hex): Promise<Hex> {
    const response = await this.request("/tx", { method: "POST", body: rawHex });
    return (await response.text()).trim();
  }

  private async fee(txid: Hex): Promise<{ fee: number; vsize: number }> {
    const tx = (await (await this.request(`/tx/${txid}`)).json()) as {
      fee: number;
      weight: number;
    };
    return { fee: tx.fee, vsize: Math.ceil(tx.weight / 4) };
  }

  /**
   * `/tx/:id/outspend/:vout` for the spender and `/tx/:id` for its fee. Esplora has no descendant
   * fees, so they are summed by walking unconfirmed `/outspends` (at most 25 transactions).
   */
  async getSpender(outpoint: { txid: Hex; vout: number }): Promise<Spender | null> {
    const outspend = (await (
      await this.request(`/tx/${outpoint.txid}/outspend/${outpoint.vout}`)
    ).json()) as Outspend;
    if (!outspend.spent || !outspend.txid || outspend.status?.confirmed) return null;
    const own = await this.fee(outspend.txid);
    let descendantFees = BigInt(own.fee);
    const seen = new Set([outspend.txid]);
    const queue = [outspend.txid];
    while (queue.length > 0 && seen.size < MAX_DESCENDANTS) {
      const parent = queue.shift() as string;
      const children = (await (await this.request(`/tx/${parent}/outspends`)).json()) as Outspend[];
      for (const child of children) {
        if (!child.spent || !child.txid || child.status?.confirmed || seen.has(child.txid)) {
          continue;
        }
        seen.add(child.txid);
        queue.push(child.txid);
        descendantFees += BigInt((await this.fee(child.txid)).fee);
      }
    }
    return {
      txid: outspend.txid,
      fee_rate_sat_vb: own.fee / own.vsize,
      fee_sats: own.fee.toString(),
      descendant_fees_sats: descendantFees.toString(),
    };
  }
}
