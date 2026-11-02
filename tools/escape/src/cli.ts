#!/usr/bin/env node
/**
 * morrow-escape: spend a Morrow Vault through the Escape Path with only the Vault Kit and the
 * Owner Key. Works with no NEAR and no Morrow service; `--offline` makes no network call at all.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildEscape, EscapeError, parseKit, type EscapeCoin } from "./escape.js";
import { Esplora } from "./esplora.js";

const USAGE = `Usage:
  morrow-escape --kit vault-kit.json --to <address> [--fee-rate 2] --esplora <url>
  morrow-escape --kit vault-kit.json --to <address> [--fee-rate 2] --offline --height <tip>
                --utxo <txid:vout:value:height[:allowance]> [--utxo ...]
The Owner Key (32-byte hex) is read from --key-file or the MORROW_OWNER_KEY environment variable.`;

function ownerKey(keyFile: string | undefined): Uint8Array {
  const raw = (keyFile ? readFileSync(keyFile, "utf8") : (process.env.MORROW_OWNER_KEY ?? ""))
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw))
    throw new EscapeError("Owner Key must be 32 bytes of hex (--key-file or MORROW_OWNER_KEY)");
  return Uint8Array.from(raw.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

function parseUtxo(value: string): EscapeCoin {
  const [txid, vout, sats, height, source] = value.split(":");
  if (!txid || !/^[0-9a-f]{64}$/.test(txid) || vout === undefined || !sats || !height) {
    throw new EscapeError(`Bad --utxo "${value}"; expected txid:vout:value:height[:allowance]`);
  }
  return {
    txid,
    vout: Number(vout),
    value_sats: BigInt(sats),
    height: Number(height),
    source: source === "allowance" ? "allowance" : "vault",
  };
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      kit: { type: "string" },
      to: { type: "string" },
      "fee-rate": { type: "string", default: "2" },
      "key-file": { type: "string" },
      esplora: { type: "string" },
      offline: { type: "boolean", default: false },
      height: { type: "string" },
      utxo: { type: "string", multiple: true },
    },
  });
  if (!values.kit || !values.to || (!values.offline && !values.esplora)) {
    console.error(USAGE);
    return 2;
  }
  const kit = parseKit(readFileSync(values.kit, "utf8"));
  const request = {
    kit,
    ownerSecretKey: ownerKey(values["key-file"]),
    destination: values.to,
    feeRateSatVb: Number(values["fee-rate"]),
  };

  if (values.offline) {
    if (!values.height || !values.utxo?.length) {
      console.error(USAGE);
      return 2;
    }
    const result = buildEscape({
      ...request,
      coins: values.utxo.map(parseUtxo),
      tipHeight: Number(values.height),
    });
    console.log(result.rawHex);
    console.error(
      `Escape transaction ${result.txid}: ${result.amount_sats} sats to ${values.to}, fee ${result.fee_sats} sats. Broadcast it from any node.`,
    );
    return 0;
  }

  const esplora = new Esplora(values.esplora ?? "");
  const coins: EscapeCoin[] = [];
  for (const source of ["vault", "allowance"] as const) {
    for (const coin of await esplora.coins(kit.addresses[source])) {
      if (!coin.status.confirmed || coin.status.block_height === undefined) continue;
      coins.push({
        txid: coin.txid,
        vout: coin.vout,
        value_sats: BigInt(coin.value),
        height: coin.status.block_height,
        source,
      });
    }
  }
  const result = buildEscape({ ...request, coins, tipHeight: await esplora.tipHeight() });
  const txid = await esplora.broadcast(result.rawHex);
  console.log(`Escaped ${result.amount_sats} sats to ${values.to}: ${txid}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
