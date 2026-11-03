import { address as btcAddress, networks } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import type { BtcNetwork } from "../contract/types.js";
import { decodeSegwitAddress, randomP2wpkhAddress } from "./browser-address.js";

// BIP173 / BIP350 vectors.
const VALID: [string, BtcNetwork, 0 | 1, number][] = [
  ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "bitcoin", 0, 20],
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bitcoin", 0, 20],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "signet", 0, 32],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "testnet4", 0, 32],
  ["tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy", "signet", 0, 32],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "bitcoin", 1, 32],
  ["tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "signet", 1, 32],
  ["bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", "regtest", 0, 20],
];

const INVALID: [string, BtcNetwork, string][] = [
  // Bad checksum, mixed case, empty, junk.
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8", "signet", "malformed"],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3Q0sl5k7", "signet", "malformed"],
  ["", "signet", "malformed"],
  ["not an address", "signet", "malformed"],
  ["mkHS9ne12qx9pS9VojpwU5xtRd4T7X7ZUt", "signet", "malformed"],
  // Another network's HRP.
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "signet", "network"],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "bitcoin", "network"],
  ["bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw", "bitcoin", "network"],
  ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "regtest", "network"],
  // Witness version 2+ (valid bech32m) is not accepted by the contract.
  ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "bitcoin", "version"],
  ["BC1SW50QGDZ25J", "bitcoin", "version"],
  // v0 with bech32m, v1 with bech32, v0 with a 16-byte program, v1 with 20 bytes.
  ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "bitcoin", "program"],
  ["tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47", "signet", "program"],
  ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "bitcoin", "program"],
  ["BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", "bitcoin", "program"],
];

const BITCOINJS = {
  bitcoin: networks.bitcoin,
  signet: networks.testnet,
  testnet4: networks.testnet,
  regtest: networks.regtest,
};

describe("SegWit addresses checked in the browser", () => {
  it.each(VALID)("accepts %s on %s", (address, network, version, length) => {
    const decoded = decodeSegwitAddress(address, network);
    expect(decoded).toMatchObject({ ok: true, version });
    if (decoded.ok) {
      expect(decoded.program).toHaveLength(length);
      // Same version and program as bitcoinjs-lib.
      const theirs = btcAddress.fromBech32(address);
      expect(theirs.version).toBe(version);
      expect([...theirs.data]).toEqual([...decoded.program]);
    }
  });

  it.each(INVALID)("refuses %s on %s (%s)", (address, network, problem) => {
    expect(decodeSegwitAddress(address, network)).toEqual({ ok: false, problem });
  });

  it("refuses an address longer than 90 characters", () => {
    expect(decodeSegwitAddress(`tb1q${"q".repeat(90)}`, "signet")).toEqual({
      ok: false,
      problem: "malformed",
    });
  });

  it.each(["signet", "testnet4", "bitcoin", "regtest"] as const)(
    "draws a fresh valid P2WPKH address on %s",
    (network) => {
      const a = randomP2wpkhAddress(network);
      const b = randomP2wpkhAddress(network);
      expect(a).not.toBe(b);
      for (const address of [a, b]) {
        expect(decodeSegwitAddress(address, network)).toMatchObject({ ok: true, version: 0 });
        expect(btcAddress.toOutputScript(address, BITCOINJS[network])).toHaveLength(22);
      }
    },
  );
});
