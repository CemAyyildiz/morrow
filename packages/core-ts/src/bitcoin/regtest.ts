import type { Hex } from "../contract/types.js";
import { BitcoindRpc } from "./bitcoind-rpc.js";

/** Regtest-only helpers for Judge Mode: fund addresses and mine blocks with the "miner" wallet. */
export class RegtestControl {
  constructor(
    readonly rpc: BitcoindRpc,
    private readonly wallet = "miner",
  ) {}

  async mine(blocks = 1): Promise<void> {
    const address = await this.rpc.call<string>("getnewaddress", [], this.wallet);
    await this.rpc.call("generatetoaddress", [blocks, address]);
  }

  /** Sends `sats` to `address` and returns the txid (unconfirmed until `mine`). */
  async fund(address: string, sats: bigint): Promise<Hex> {
    const btc = `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, "0")}`;
    return this.rpc.call<string>("sendtoaddress", [address, btc], this.wallet);
  }

  async newAddress(): Promise<string> {
    return this.rpc.call<string>("getnewaddress", ["", "bech32"], this.wallet);
  }
}
