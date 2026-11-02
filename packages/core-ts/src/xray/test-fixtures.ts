import type { TxStatus } from "../bitcoin/backend.js";
import type { AccountId, Hex, SpendOp, U64 } from "../contract/types.js";
import {
  NearRpcError,
  encodeBase64Json,
  type NearRpc,
  type RpcBlockHeader,
  type RpcTxStatus,
} from "./ports.js";

/**
 * Receipt-tree builders shaped like testnet `EXPERIMENTAL_tx_status` results (receipt order,
 * predecessors, receivers, method names, `SuccessReceiptId` links, failure shape), checked on
 * 2026-11-02 against `2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD` (sign_input, op 25 input 0)
 * and `6wxakLCXRgR9jeGJ3cfKoc1itu7B3zLU7BAWnTKc8stA` (begin_execute refused with
 * ERR_CLAWED_BACK). The trees are synthetic: only `OP25` and the ids, sighash, path, signature
 * and sign block passed into `OP25_INPUT0_TX` are real.
 */

export const TESTNET_CONTRACT = "morrow-vault-dev3.testnet";
export const TESTNET_SIGNER = "v1.signer-prod.testnet";
export const TESTNET_SENDER = "morrow-judge-mvz5zdge-dm9o0f.testnet";
export const OP25_SIGN_TX = "2FWpHLw9foW3pLviW8qocbit61ygroWotrPx8kuEv5qD";
export const OP25_TXID = "35e3e3cb7adc2c38922fccc201a12ce616a18c0d0a7c326856f605a4719f8d1a";

/** `get_op {"op_id":"25"}` on morrow-vault-dev3.testnet. */
export const OP25: SpendOp = {
  op_id: "25",
  vault_id: "29",
  kind: "withdrawal",
  source: "vault",
  state: "signed",
  amount_sats: "1500000",
  destination: "bcrt1q52rnz9zzft0r5ccqfa0y5rupkedd9244lxpnmj",
  fee_rate_sat_vb: 2,
  utxos: [
    {
      txid: "471f8c6b89d76228a04c0480aaef215610df5c712884c2c24c0cb97ea771b3ba",
      vout: 0,
      value_sats: "1000000",
    },
    {
      txid: "7c7b45fd7edacb29e9d2121e16267737e4222e01f6489761d298595151f44cd7",
      vout: 1,
      value_sats: "1000000",
    },
  ],
  created_at: "1793618275571430727",
  executable_at: "1793618335571430727",
  unsigned_tx_hex:
    "0200000002bab371a77eb90c4cc2c28428715cdf105621efaa80044ca02862d7896b8c1f470000000000fdffffffd74cf451515998d2619748f6012e22e4377726161e12d2e929cbda7efd457b7c0100000000fdffffff0260e3160000000000160014a2873114424ade3a63004f5e4a0f81b65ad2aab5809e070000000000220020f3bdc06f9f571d37dccadd55bd67d209edaadb2bd9ba909ba325cec90e53b23d00000000",
  sighashes: [
    "ddb6d4436c2f4454d6d315cce9a537a4b6ade98f1c1f59c97e5819f65ca058e2",
    "89ae19f6aea8d1b2e0f592a68ca3167a7ae41c0b1359a0a8599ba285734c0234",
  ],
  signatures: [
    "0280bb6ddf9c03884112d11866a164a76d0b5aa6ad043945baeffa20de5f5304034ac1c518c8e176b2fd481c5c665c6b37a8c835b1381b98e1778eda27ef134ea0",
    "020be88a204c5912a949b5de2067a68e5e7e042bd313dbd0dcc2ba5bb90e52e4cb0888b0ac4bd9e1917968a4096a6f580c6c98226d54a35465b2e24514d201630f",
  ],
  witness_template: {
    path: "withdrawal",
    slots: [
      { kind: "signature", signer: "cosigner" },
      { kind: "signature", signer: "owner" },
      { kind: "selector", hex: "01" },
      { kind: "script" },
    ],
  },
};

/** The signer's `state` view, trimmed to what X-Ray reads (v3.18.0, 16 participants, 11). */
export function signerState(participants = 16, threshold = 11): unknown {
  return {
    Running: {
      domains: {
        domains: [
          { id: 0, protocol: "CaitSith", reconstruction_threshold: threshold, purpose: "Sign" },
          { id: 1, protocol: "Frost", reconstruction_threshold: threshold, purpose: "Sign" },
        ],
        next_domain_id: 2,
      },
      parameters: {
        participants: {
          next_id: participants,
          participants: Array.from({ length: participants }, (_, i) => [
            `mpc-${i}.testnet`,
            i,
            { url: `http://10.0.0.${i}:80`, tls_public_key: `ed25519:key${i}` },
          ]),
        },
        threshold,
      },
    },
  };
}

const fc = (method_name: string, args: unknown) => ({
  FunctionCall: {
    method_name,
    args: encodeBase64Json(args),
    gas: 100_000_000_000_000,
    deposit: "0",
  },
});

const outcome = (
  id: string,
  block_hash: string,
  executor_id: AccountId,
  status: RpcTxStatus["status"],
  logs: string[] = [],
  receipt_ids: string[] = [],
) => ({ id, block_hash, outcome: { executor_id, logs, receipt_ids, status } });

export interface SignTxParams {
  hash: string;
  sender?: AccountId;
  contractId?: AccountId;
  signer?: AccountId;
  opId: U64;
  inputIndex: number;
  vaultId: U64;
  role?: "vault" | "allowance";
  /** Sent as `payload_v2.Ecdsa`. */
  payload: Hex;
  /** Stored form, `big_r` (33 bytes) then `s`; also what `on_signed` returns unless overridden. */
  signature: Hex;
  callbackValue?: Hex;
  signReceiptId?: string;
  responseReceiptId?: string;
  callbackReceiptId?: string;
  signBlockHash?: string;
  /** The signer returned no signature: the response fails and `on_signed` panics ERR_SIGNER_FAILED. */
  failed?: boolean;
}

/** A `sign_input` transaction tree: vault → signer `sign` → response → `on_signed`. */
export function signInputTx(p: SignTxParams): RpcTxStatus {
  const contract = p.contractId ?? TESTNET_CONTRACT;
  const signer = p.signer ?? TESTNET_SIGNER;
  const sender = p.sender ?? TESTNET_SENDER;
  const first = `${p.hash}-first`;
  const sign = p.signReceiptId ?? `${p.hash}-sign`;
  const response = p.responseReceiptId ?? `${p.hash}-response`;
  const callback = p.callbackReceiptId ?? `${p.hash}-callback`;
  const signBlock = p.signBlockHash ?? `${p.hash}-sign-block`;
  const args = { op_id: p.opId, input_index: p.inputIndex };
  const stored = p.callbackValue ?? p.signature;
  const signerFailed = {
    Failure: {
      ActionError: {
        index: 0,
        kind: {
          FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_SIGNER_FAILED" },
        },
      },
    },
  };
  return {
    status: p.failed ? signerFailed : { SuccessValue: encodeBase64Json(stored) },
    transaction: {
      hash: p.hash,
      signer_id: sender,
      receiver_id: contract,
      actions: [fc("sign_input", args)],
    },
    transaction_outcome: outcome(p.hash, `${p.hash}-tx-block`, sender, { SuccessReceiptId: first }),
    receipts: [
      {
        receipt_id: first,
        predecessor_id: sender,
        receiver_id: contract,
        receipt: { Action: { actions: [fc("sign_input", args)] } },
      },
      {
        receipt_id: sign,
        predecessor_id: contract,
        receiver_id: signer,
        receipt: {
          Action: {
            actions: [
              fc("sign", {
                request: {
                  payload_v2: { Ecdsa: p.payload },
                  path: `morrow/v1/${p.vaultId}/${p.role ?? "vault"}`,
                  domain_id: 0,
                },
              }),
            ],
          },
        },
      },
      {
        receipt_id: response,
        predecessor_id: signer,
        receiver_id: signer,
        receipt: {
          Action: {
            actions: [
              fc("return_signature_and_clean_state_on_success", [
                { tweak: [1, 2, 3], payload: { Ecdsa: p.payload }, domain_id: 0 },
              ]),
            ],
          },
        },
      },
      {
        receipt_id: `${p.hash}-refund`,
        predecessor_id: "system",
        receiver_id: sender,
        receipt: { Action: { actions: ["Transfer"] } },
      },
      {
        receipt_id: callback,
        predecessor_id: contract,
        receiver_id: contract,
        receipt: { Action: { actions: [fc("on_signed", args)] } },
      },
    ],
    receipts_outcome: [
      outcome(
        first,
        `${p.hash}-first-block`,
        contract,
        { SuccessReceiptId: callback },
        [],
        [sign, callback],
      ),
      outcome(sign, signBlock, signer, { SuccessReceiptId: response }, [
        `sign: predecessor=AccountId("${contract}"), request=SignRequestArgs { ... }`,
      ]),
      outcome(
        response,
        `${p.hash}-response-block`,
        signer,
        p.failed
          ? {
              Failure: {
                ActionError: {
                  index: 0,
                  kind: {
                    FunctionCallError: { ExecutionError: "Signature request has timed out." },
                  },
                },
              },
            }
          : {
              SuccessValue: encodeBase64Json({
                scheme: "Secp256k1",
                big_r: { affine_point: p.signature.slice(0, 66) },
                s: { scalar: p.signature.slice(66) },
                recovery_id: 1,
              }),
            },
      ),
      outcome(`${p.hash}-refund`, `${p.hash}-refund-block`, sender, { SuccessValue: "" }),
      outcome(
        callback,
        `${p.hash}-callback-block`,
        contract,
        p.failed ? signerFailed : { SuccessValue: encodeBase64Json(stored) },
        p.failed
          ? []
          : [
              `EVENT_JSON:{"standard":"morrow","version":"1.0.0","event":"input_signed","data":[{"vault_id":"${p.vaultId}","payload":{"op_id":"${p.opId}","input_index":${p.inputIndex}}}]}`,
            ],
      ),
    ],
  };
}

/**
 * Op 25 input 0: real tx hash, receipt ids, sighash, path, signature and `sign` block; the
 * surrounding tree (tweak, logs, other receipts) is synthetic.
 */
export const OP25_INPUT0_TX = signInputTx({
  hash: OP25_SIGN_TX,
  opId: "25",
  inputIndex: 0,
  vaultId: "29",
  payload: OP25.sighashes[0] ?? "",
  signature: OP25.signatures[0] ?? "",
  signReceiptId: "ELNqtFfutMEWhjDwHbcgMgMBQ49gXWU87vSnYEjDwYXa",
  responseReceiptId: "8A3hGTAiz8KSgH1fb7kzCT4AdG3GfBfjgnJp8iX7BMFQ",
  callbackReceiptId: "CiEd7fYkXkzgGEcLpHw76cVW8vG4uzL9VyiD3gXs8UPh",
  signBlockHash: "7ZC9L8JVi7m25vC2JrbqkEaVy48DHv2Kv6xG6obSpCUH",
});

export interface RefusedTxParams {
  hash: string;
  sender?: AccountId;
  contractId?: AccountId;
  method: string;
  args: Record<string, unknown>;
  /** Panic text, e.g. `ERR_NOT_EXECUTABLE`. */
  panic: string;
  receiptId?: string;
  blockHash?: string;
}

/** A call the contract rejected: one vault receipt whose outcome is a FunctionCallError panic. */
export function refusedTx(p: RefusedTxParams): RpcTxStatus {
  const contract = p.contractId ?? TESTNET_CONTRACT;
  const sender = p.sender ?? TESTNET_SENDER;
  const receipt = p.receiptId ?? `${p.hash}-receipt`;
  const failure = {
    Failure: {
      ActionError: {
        index: 0,
        kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${p.panic}` } },
      },
    },
  };
  return {
    status: failure,
    transaction: {
      hash: p.hash,
      signer_id: sender,
      receiver_id: contract,
      actions: [fc(p.method, p.args)],
    },
    transaction_outcome: outcome(p.hash, `${p.hash}-tx-block`, sender, {
      SuccessReceiptId: receipt,
    }),
    receipts: [
      {
        receipt_id: receipt,
        predecessor_id: sender,
        receiver_id: contract,
        receipt: { Action: { actions: [fc(p.method, p.args)] } },
      },
      {
        receipt_id: `${p.hash}-refund`,
        predecessor_id: "system",
        receiver_id: sender,
        receipt: { Action: { actions: ["Transfer"] } },
      },
    ],
    receipts_outcome: [
      outcome(receipt, p.blockHash ?? `${p.hash}-block`, contract, failure),
      outcome(`${p.hash}-refund`, `${p.hash}-refund-block`, sender, { SuccessValue: "" }),
    ],
  };
}

type View = (accountId: AccountId, method: string, args: object, blockHash?: string) => unknown;

/** In-memory archival RPC. Unknown hashes fail like nearcore (`UNKNOWN_TRANSACTION`). */
export class FakeNearRpc implements NearRpc {
  readonly txs = new Map<string, RpcTxStatus>();
  readonly headers = new Map<string, RpcBlockHeader>();
  readonly calls: string[] = [];

  constructor(private readonly view: View) {}

  add(tx: RpcTxStatus): this {
    this.txs.set(tx.transaction.hash, tx);
    return this;
  }

  async txStatus(hash: string, senderId: AccountId): Promise<RpcTxStatus> {
    this.calls.push(`tx ${hash} ${senderId}`);
    const tx = this.txs.get(hash);
    if (!tx || tx.transaction.signer_id !== senderId) {
      throw new NearRpcError("EXPERIMENTAL_tx_status: UNKNOWN_TRANSACTION", "UNKNOWN_TRANSACTION");
    }
    return structuredClone(tx);
  }

  async viewAt(accountId: AccountId, method: string, args: object, blockHash?: string) {
    this.calls.push(`view ${accountId} ${method} ${blockHash ?? "final"}`);
    return structuredClone(await this.view(accountId, method, args, blockHash));
  }

  async blockHeader(blockHash: string): Promise<RpcBlockHeader> {
    this.calls.push(`block ${blockHash}`);
    const header = this.headers.get(blockHash);
    if (!header) throw new NearRpcError(`block: UNKNOWN_BLOCK ${blockHash}`, "UNKNOWN_BLOCK");
    return header;
  }
}

/** In-memory `BitcoinBackend.getTx`. */
export class FakeBitcoin {
  readonly txs = new Map<string, TxStatus>();
  readonly calls: string[] = [];

  async getTx(txid: Hex): Promise<TxStatus | null> {
    this.calls.push(txid);
    return this.txs.get(txid) ?? null;
  }
}
