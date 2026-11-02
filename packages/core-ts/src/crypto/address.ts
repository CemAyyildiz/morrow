import { networks, payments, type Network } from "bitcoinjs-lib";
import type { BtcNetwork } from "../contract/types.js";
import { CryptoError } from "./errors.js";
import { hexToBytes } from "./hex.js";

const NETWORKS: Record<BtcNetwork, Network> = {
  bitcoin: networks.bitcoin,
  testnet4: networks.testnet,
  signet: networks.testnet,
  regtest: networks.regtest,
};

/**
 * Recomputes the P2WSH address of a contract-published script, so anyone can check that the
 * address holding the coins really is the script the Proof Page shows.
 */
export function recomputeAddress(scriptHex: string, network: BtcNetwork): string {
  const { address } = payments.p2wsh({
    redeem: { output: hexToBytes(scriptHex) },
    network: NETWORKS[network],
  });
  if (!address) throw new CryptoError("Could not derive a P2WSH address");
  return address;
}
