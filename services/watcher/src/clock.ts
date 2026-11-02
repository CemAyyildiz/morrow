/** "Now" for schedulers: the latest final NEAR block time, never the wall clock. */
export interface ChainClock {
  /** Nanoseconds since the Unix epoch. */
  now(): Promise<bigint>;
}

/** Reads the latest final block header from a NEAR RPC endpoint. */
export class NearFinalBlockClock implements ChainClock {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async now(): Promise<bigint> {
    const response = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "morrow-clock",
        method: "block",
        params: { finality: "final" },
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      result?: { header?: { timestamp_nanosec?: string; timestamp?: number } };
      error?: { message?: string };
    } | null;
    const header = body?.result?.header;
    if (!response.ok || !header) {
      throw new Error(
        `NEAR RPC block failed: ${body?.error?.message ?? `HTTP ${response.status}`}`,
      );
    }
    if (header.timestamp_nanosec) return BigInt(header.timestamp_nanosec);
    if (header.timestamp !== undefined) return BigInt(header.timestamp);
    throw new Error("NEAR RPC block header has no timestamp");
  }
}
