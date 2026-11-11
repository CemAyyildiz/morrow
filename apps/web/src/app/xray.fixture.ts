// Test-only: X-Ray fixtures shaped like `buildXRay` output for op 25 on testnet (see core-ts
// xray/test-fixtures.ts), for xray.test.ts and XRayView.test.ts. Never imported by the app.
import {
  bytesToHex,
  p2wshAddress,
  vaultScriptTemplate,
  type MpcInput,
  type Sourced,
  type XRay,
} from "@morrow/core-ts/browser";

export const CONTRACT = "morrow-vault-v1.testnet";
export const NOW = new Date(2026, 10, 3, 9, 30).getTime();
export const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
export const OP_REF = `query call_function ${CONTRACT} get_op {"op_id":"25"} finality=final`;
export const KIT_REF = `query call_function ${CONTRACT} get_vault_kit {"vault_id":"29"} finality=final`;
export const SIGN_TX = "2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD";
export const TX_URL = `https://testnet.nearblocks.io/txns/${SIGN_TX}`;
export const TXID = "35e3e3cb7adc2c38922fccc201a12ce616a18c0d0a7c326856f605a4719f8d1a";
export const TXID_URL = `https://mempool.space/signet/tx/${TXID}`;

export const src = <T>(value: T, ref: string, url: string | null = null): Sourced<T> => ({
  value,
  source: { ref, url },
});

export const SCRIPT = vaultScriptTemplate(
  `02${"11".repeat(32)}`,
  `03${"22".repeat(32)}`,
  [`02${"33".repeat(32)}`],
  26_280,
).script;
export const SCRIPT_HEX = bytesToHex(SCRIPT);
export const ADDRESS = p2wshAddress(SCRIPT, "signet");

export function input(index: number, over: Partial<MpcInput> = {}): MpcInput {
  const s = <T>(value: T, path: string) => src(value, `EXPERIMENTAL_tx_status … → ${path}`, TX_URL);
  return {
    status: "done",
    index: src(index, `${OP_REF} → sighashes[${index}]`),
    sighash: src("dd".repeat(32), `${OP_REF} → sighashes[${index}]`),
    payload: s("dd".repeat(32), "payload_v2.Ecdsa"),
    domainId: s(0, "domain_id"),
    path: s("morrow/v1/29/vault", "path"),
    signer: s("v1.signer-prod.testnet", "receiver_id"),
    txHash: s(SIGN_TX, "transaction.hash"),
    signReceiptId: s("Rsign", "receipt_id"),
    responseReceiptId: s("Rresp", "id"),
    callbackReceiptId: s("Rcb", "id"),
    response: s({ big_r: { affine_point: "02ab" }, s: { scalar: "cd" } }, "SuccessValue"),
    callbackValue: s("02".padEnd(130, "a"), "SuccessValue"),
    signature: src("02".padEnd(130, "a"), `${OP_REF} → signatures[${index}]`),
    participants: src(16, "state → participants.length"),
    threshold: src(11, "state → threshold"),
    protocol: src("CaitSith", "state → protocol"),
    note: null,
    ...over,
  };
}

export function signedOp(): XRay {
  return {
    opId: src("25", `${OP_REF} → op_id`),
    vaultId: src("29", `${OP_REF} → vault_id`),
    btcNetwork: src("signet", `${KIT_REF} → btc_network`),
    script: {
      status: "done",
      path: src("withdrawal", `${OP_REF} → witness_template.path`),
      coinSource: src("vault", `${OP_REF} → source`),
      scriptHex: src(SCRIPT_HEX, `${KIT_REF} → vault_script_hex`),
      address: src(ADDRESS, `${KIT_REF} → addresses.vault`),
      template: src(
        {
          path: "withdrawal",
          slots: [
            { kind: "signature", signer: "cosigner" },
            { kind: "signature", signer: "owner" },
            { kind: "selector", hex: "01" },
            { kind: "script" },
          ],
        },
        `${OP_REF} → witness_template`,
      ),
    },
    rule: {
      status: "done",
      events: [
        {
          seq: src("101", "events_since … → [3].seq"),
          kind: src("withdrawal_requested", "events_since … → [3].kind"),
          blockTimestamp: src(ns(NOW - 60_000), "events_since … → [3].block_timestamp"),
          facts: {
            op_id: src("25", "events_since … → [3].data.op_id"),
            executable_at: src(ns(NOW), "events_since … → [3].data.executable_at"),
          },
        },
      ],
      opState: src("signed", `${OP_REF} → state`),
      executableAt: src(ns(NOW), `${OP_REF} → executable_at`),
      feeSats: src("1000", "events_since … → [4].data.fee_sats"),
      voidedBy: null,
      refusal: null,
    },
    mpc: { status: "done", inputs: [input(0), input(1)] },
    bitcoin: {
      status: "done",
      txid: src(TXID, `${OP_REF} → unsigned_tx_hex (txid)`, TXID_URL),
      confirmations: src(3, `BitcoinBackend.getTx "${TXID}" → confirmations`, TXID_URL),
      blockHeight: src(290_100, `BitcoinBackend.getTx "${TXID}" → block_height`, TXID_URL),
    },
  };
}

export function refusedCall(): XRay {
  const ref = `EXPERIMENTAL_tx_status {"tx_hash":"H"}`;
  const url = "https://testnet.nearblocks.io/txns/H";
  return {
    opId: src("31", `${OP_REF} → op_id`),
    vaultId: src("29", `${OP_REF} → vault_id`),
    btcNetwork: src("signet", `${KIT_REF} → btc_network`),
    script: { ...signedOp().script },
    rule: {
      status: "refused",
      events: [],
      opState: null,
      executableAt: null,
      feeSats: null,
      voidedBy: null,
      refusal: {
        code: src("ERR_NOT_EXECUTABLE", `${ref} → Failure`, url),
        gloss: src(
          "The Delay has not passed yet. The Withdrawal Request is still pending.",
          "ERROR_CODES.ERR_NOT_EXECUTABLE (@morrow/core-ts)",
        ),
        method: src("begin_execute", `${ref} → method_name`, url),
        args: src({ op_id: "31" }, `${ref} → args`, url),
        txHash: src("H", `${ref} → transaction.hash`, url),
        receiptId: src("R", `${ref} → id`, url),
        facts: {
          blockTimestamp: src(ns(NOW - 3_600_000), "block {} → header.timestamp_nanosec"),
          executableAt: src(ns(NOW + 3_600_000), "get_op at parent → executable_at"),
          opState: src("pending", "get_op at parent → state"),
        },
      },
    },
    mpc: { status: "not_reached", inputs: [] },
    bitcoin: { status: "not_reached", txid: null, confirmations: null, blockHeight: null },
  };
}
