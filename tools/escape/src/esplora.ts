/** Minimal Esplora client (mempool.space and compatible), so the Escape tool needs no other code. */
export interface EsploraCoin {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export class Esplora {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.fetchFn(`${this.base}${path}`, init);
    if (!response.ok)
      throw new Error(
        `${path}: HTTP ${response.status} ${await response.text().catch(() => "")}`.trim(),
      );
    return response;
  }

  async tipHeight(): Promise<number> {
    return Number(await (await this.request("/blocks/tip/height")).text());
  }

  async coins(address: string): Promise<EsploraCoin[]> {
    return (await (await this.request(`/address/${address}/utxo`)).json()) as EsploraCoin[];
  }

  async broadcast(rawHex: string): Promise<string> {
    return (await (await this.request("/tx", { method: "POST", body: rawHex })).text()).trim();
  }
}
