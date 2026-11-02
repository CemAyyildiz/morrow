import type { BitcoinBackend } from "./backend.js";
import { BitcoindRpc } from "./bitcoind-rpc.js";
import { Esplora } from "./esplora.js";

/** A URL with credentials (http://user:pass@host:port) is Bitcoin Core RPC; anything else is Esplora. */
export function backendFromUrl(url: string, fetchFn: typeof fetch = fetch): BitcoinBackend {
  return new URL(url).username ? new BitcoindRpc(url, fetchFn) : new Esplora(url, fetchFn);
}
