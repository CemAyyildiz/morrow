import type { BtcNetwork, Hex } from "../contract/types.js";

export type NearNetwork = "testnet" | "mainnet";

/** NearBlocks transaction page. */
export function nearTxUrl(network: NearNetwork, hash: string): string {
  const host = network === "mainnet" ? "nearblocks.io" : "testnet.nearblocks.io";
  return `https://${host}/txns/${hash}`;
}

const MEMPOOL_PREFIX: Record<BtcNetwork, string | null> = {
  bitcoin: "https://mempool.space",
  signet: "https://mempool.space/signet",
  testnet4: "https://mempool.space/testnet4",
  regtest: null,
};

/** mempool.space transaction page; null on regtest, which has no public explorer. */
export function bitcoinTxUrl(network: BtcNetwork, txid: Hex): string | null {
  const prefix = MEMPOOL_PREFIX[network];
  return prefix === null ? null : `${prefix}/tx/${txid}`;
}
