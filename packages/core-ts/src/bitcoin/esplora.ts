import type { Hex } from "../contract/types.js";
import { BitcoinBackendError, type BitcoinBackend, type TxStatus, type Utxo } from "./backend.js";

type Fetch = typeof fetch;

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
}
