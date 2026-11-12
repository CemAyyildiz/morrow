// Local stand-ins for the services the page may reach, for the e2e run only:
// `node e2e/stub-services.ts`.
// - NEAR RPC: `view_access_key_list` of the contract with one function-call key (a locked
//   contract), `call_function get_vault` (Delay, Owner Account, watcher key) and the signer's
//   `state` (threshold 11 of 16). For the Proof Page (proof-fixture.ts): `view_account` (the
//   code hash), the full `get_vault` and `get_vault_kit` of Vault #7, ERR_VAULT_NOT_FOUND for
//   other ids, and `events_since` over a fixed log. For "Try with these keys":
//   `view_access_key` (a nonce per key), `block` (final) and `send_tx`, which checks the
//   ed25519 signature over sha256 of the borsh transaction, records it
//   (`GET /__sent?public_key=`), and answers `request_withdrawal` with an op id and its
//   `withdrawal_requested` log, `begin_execute` with ERR_NOT_EXECUTABLE.
//   It never runs a contract. `POST /__allowance {public_key, spent}` makes a key out of
//   allowance; `POST /__nonce {public_key, race}` answers its next `race` sends with
//   InvalidNonce, as when other visitors use the key at the same time: the error names the
//   nonce they took while `view_access_key` (final) still answers the older one.
// - Watcher: `/heartbeat`, one minute old.
// - Bitcoin backend: the challenge Vault's UTXOs, none for Vault #7 (the wallet page's unfunded
//   Vault) and the tip height; 404 otherwise.
// - Challenge feed (`tools/challenge run`): `GET /round` and `GET /attempts` from
//   challenge-fixture.ts. `POST /__attempt` appends a clawed-back attempt, so a spec can see a
//   new row arrive; its optional body `{op_id, clawback_txid, clawback_broadcast}` ties it to
//   an attempt the page sent.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  DELAY_NS,
  WATCHER_X25519_PK,
  base58,
  OWNER_ACCOUNT,
  ROUND,
  ROUND_NUMBER,
  SIGNER,
  TIP_HEIGHT,
  VAULT_ADDRESS,
  VAULT_ID,
  VAULT_SATS,
  attemptsAt,
} from "./challenge-fixture.ts";
import {
  CODE_HASH,
  PROOF_EVENTS,
  PROOF_KIT,
  PROOF_VAULT,
  PROOF_VAULT_ADDRESS,
  PROOF_VAULT_ID,
} from "./proof-fixture.ts";
import {
  BACKEND_PORT,
  CHALLENGE_PORT,
  RPC_PORT,
  STUB_HEARTBEAT_AGE_MS,
  WATCHER_PORT,
  WEB_ENV,
} from "./services.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { ...CORS, "content-type": "application/json" });
  response.end(body === null ? undefined : JSON.stringify(body));
}

/** A `call_function` result: the JSON value as UTF-8 bytes. */
const viewResult = (value: unknown) => ({
  block_hash: "stub",
  block_height: 1,
  logs: [],
  result: [...Buffer.from(JSON.stringify(value))],
});

const SIGNER_STATE = {
  Running: {
    parameters: {
      threshold: SIGNER.threshold,
      participants: {
        next_id: SIGNER.total,
        participants: Array.from({ length: SIGNER.total }, (_, i) => [`mpc-${i}.testnet`, i, {}]),
      },
    },
  },
};

function rpcResult(params: Record<string, unknown> | undefined): unknown {
  if (params?.request_type === "view_access_key_list") {
    if (params.account_id !== WEB_ENV.MORROW_VAULT_CONTRACT) return null;
    return {
      block_hash: "stub",
      block_height: 1,
      keys: [
        {
          public_key: "ed25519:11111111111111111111111111111111",
          access_key: {
            nonce: 1,
            permission: {
              FunctionCall: {
                allowance: null,
                receiver_id: WEB_ENV.MORROW_VAULT_CONTRACT,
                method_names: [],
              },
            },
          },
        },
      ],
    };
  }
  if (
    params?.request_type === "view_account" &&
    params.account_id === WEB_ENV.MORROW_VAULT_CONTRACT
  ) {
    return {
      amount: "100000000000000000000000000",
      locked: "0",
      code_hash: CODE_HASH,
      storage_usage: 412_000,
      storage_paid_at: 0,
      block_hash: "stub",
      block_height: 1,
    };
  }
  if (params?.request_type !== "call_function") return null;
  const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString()) as {
    vault_id?: string;
    cursor?: string;
    limit?: number;
  };
  if (params.account_id === WEB_ENV.MORROW_VAULT_CONTRACT) {
    // The Proof Page's Vault, in full (the challenge Vault "42" keeps its short shape).
    if (params.method_name === "get_vault" && args.vault_id === PROOF_VAULT_ID) {
      return viewResult(PROOF_VAULT);
    }
    if (params.method_name === "get_vault_kit" && args.vault_id === PROOF_VAULT_ID) {
      return viewResult(PROOF_KIT);
    }
    if (params.method_name === "get_vault" && args.vault_id !== VAULT_ID) {
      return VAULT_NOT_FOUND;
    }
    if (params.method_name === "events_since") {
      const cursor = BigInt(args.cursor ?? "0");
      const limit = Math.min(100, Math.max(1, args.limit ?? 100));
      return viewResult(PROOF_EVENTS.filter((e) => BigInt(e.seq) > cursor).slice(0, limit));
    }
  }
  if (
    params.account_id === WEB_ENV.MORROW_VAULT_CONTRACT &&
    params.method_name === "get_vault" &&
    args.vault_id === VAULT_ID
  ) {
    return viewResult({
      vault_id: VAULT_ID,
      owner_account: OWNER_ACCOUNT,
      state: "active",
      policy: {
        delay_ns: DELAY_NS,
        escape_timelock_blocks: 1000,
        btc_network: "signet",
        watcher_x25519_pk: WATCHER_X25519_PK,
      },
    });
  }
  if (params.account_id === "v1.signer-prod.testnet" && params.method_name === "state") {
    return viewResult(SIGNER_STATE);
  }
  return null;
}

/** What nearcore answers when a view call panics: here `get_vault` of an unknown id. */
const VAULT_NOT_FOUND = Symbol("vault not found");
const VAULT_NOT_FOUND_ERROR = {
  name: "HANDLER_ERROR",
  cause: {
    name: "CONTRACT_EXECUTION_ERROR",
    info: { vm_error: "Smart contract panicked: ERR_VAULT_NOT_FOUND" },
  },
  code: -32000,
  message: "Server error",
  data: "Smart contract panicked: ERR_VAULT_NOT_FOUND",
};

// "Try with these keys": access keys, the final block and signed transactions.

/** A final block hash (base58 of 32 bytes). */
const BLOCK_HASH = base58(createHash("sha256").update("morrow-e2e-block").digest());
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

interface SentTx {
  public_key: string;
  hash: string;
  valid: boolean;
  nonce: number;
  method: string;
  args: Record<string, unknown>;
  op_id: string | null;
}

const nonces = new Map<string, number>();
const spentKeys = new Set<string>();
const races = new Map<string, number>();
/**
 * Nonces other visitors' transactions took that `final` has not caught up with: a key's
 * `view_access_key` keeps answering the lagging nonce, as a real node does at `final`.
 */
const optimistic = new Map<string, number>();
const sent: SentTx[] = [];
let nextOpId = 500;

/** The fields of a signed one-FunctionCall transaction, and whether its signature holds. */
function readSigned(base64: string): Omit<SentTx, "op_id"> {
  const bytes = Buffer.from(base64, "base64");
  const body = bytes.subarray(0, bytes.length - 65);
  const signature = bytes.subarray(bytes.length - 64);
  let at = 0;
  const str = () => {
    const n = body.readUInt32LE(at);
    const text = body.subarray(at + 4, at + 4 + n).toString();
    at += 4 + n;
    return text;
  };
  str(); // signer_id
  at += 1; // key type
  const publicKey = body.subarray(at, at + 32);
  at += 32;
  const nonce = Number(body.readBigUInt64LE(at));
  at += 8;
  str(); // receiver_id
  at += 32; // block hash
  at += 4 + 1; // one action, FunctionCall
  const method = str();
  const args = JSON.parse(str()) as Record<string, unknown>;
  const digest = createHash("sha256").update(body).digest();
  const valid = verify(
    null,
    digest,
    createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" }),
    signature,
  );
  return {
    public_key: `ed25519:${base58(publicKey)}`,
    hash: base58(digest),
    valid,
    nonce,
    method,
    args,
  };
}

const invalidTx = (error: Record<string, unknown>) => ({
  name: "HANDLER_ERROR",
  cause: { name: "INVALID_TRANSACTION", info: {} },
  data: { TxExecutionError: { InvalidTxError: error } },
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

/** A `send_tx` answer: `{ result }` or `{ error }`. */
function sendTx(params: Record<string, unknown>): { result?: unknown; error?: unknown } {
  const tx = readSigned(String(params.signed_tx_base64));
  const record: SentTx = { ...tx, op_id: null };
  sent.push(record);
  if (!tx.valid) return { error: invalidTx({ InvalidSignature: null }) };
  const race = races.get(tx.public_key) ?? 0;
  const known = nonces.get(tx.public_key) ?? 1000;
  const taken = Math.max(known, optimistic.get(tx.public_key) ?? 0);
  if (race > 0) {
    races.set(tx.public_key, race - 1);
    optimistic.set(tx.public_key, taken + 5);
    return { error: invalidTx({ InvalidNonce: { tx_nonce: tx.nonce, ak_nonce: taken + 5 } }) };
  }
  if (tx.nonce <= taken) {
    return { error: invalidTx({ InvalidNonce: { tx_nonce: tx.nonce, ak_nonce: taken } }) };
  }
  if (spentKeys.has(tx.public_key)) {
    return {
      error: invalidTx({ InvalidAccessKeyError: { NotEnoughAllowance: { allowance: "0" } } }),
    };
  }
  nonces.set(tx.public_key, tx.nonce);
  const outcome = (status: unknown, logs: string[] = []) => ({
    id: `receipt-${tx.hash}`,
    block_hash: BLOCK_HASH,
    outcome: { executor_id: WEB_ENV.MORROW_VAULT_CONTRACT, logs, receipt_ids: [], status },
  });
  const base = {
    final_execution_status: "EXECUTED_OPTIMISTIC",
    transaction: {
      hash: tx.hash,
      signer_id: OWNER_ACCOUNT,
      receiver_id: WEB_ENV.MORROW_VAULT_CONTRACT,
      actions: [{ FunctionCall: { method_name: tx.method, args: "", gas: 30e12, deposit: "0" } }],
    },
    transaction_outcome: {
      id: tx.hash,
      block_hash: BLOCK_HASH,
      outcome: {
        executor_id: OWNER_ACCOUNT,
        logs: [],
        receipt_ids: [`receipt-${tx.hash}`],
        status: { SuccessReceiptId: `receipt-${tx.hash}` },
      },
    },
  };
  if (tx.method === "request_withdrawal") {
    record.op_id = String(nextOpId++);
    const executableAt = (BigInt(Date.now()) * 1_000_000n + BigInt(DELAY_NS)).toString();
    const log = `EVENT_JSON:${JSON.stringify({
      standard: "morrow",
      version: "1.0.0",
      event: "withdrawal_requested",
      data: [
        {
          vault_id: VAULT_ID,
          payload: { ...tx.args, op_id: record.op_id, executable_at: executableAt },
        },
      ],
    })}`;
    return {
      result: {
        ...base,
        status: { SuccessValue: b64(record.op_id) },
        receipts_outcome: [outcome({ SuccessValue: b64(record.op_id) }, [log])],
      },
    };
  }
  const failure = {
    ActionError: {
      index: 0,
      kind: {
        FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_NOT_EXECUTABLE" },
      },
    },
  };
  return {
    result: {
      ...base,
      status: { Failure: failure },
      receipts_outcome: [outcome({ Failure: failure })],
    },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += String(chunk)));
    request.on("end", () => resolve(body));
  });
}

const rpc = createServer((request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, null);
  const url = new URL(request.url ?? "/", "http://stub");
  // Test switches (never asked by the page).
  if (request.method === "GET" && url.pathname === "/__sent") {
    const key = url.searchParams.get("public_key");
    return json(
      response,
      200,
      sent.filter((tx) => tx.public_key === key),
    );
  }
  void readBody(request).then((body) => {
    if (request.method === "POST" && url.pathname === "/__allowance") {
      const { public_key: key, spent } = JSON.parse(body) as { public_key: string; spent: boolean };
      if (spent) spentKeys.add(key);
      else spentKeys.delete(key);
      return json(response, 200, { ok: true });
    }
    if (request.method === "POST" && url.pathname === "/__nonce") {
      const { public_key: key, race } = JSON.parse(body) as { public_key: string; race: number };
      races.set(key, race);
      return json(response, 200, { ok: true });
    }
    let id: unknown = null;
    try {
      const call = JSON.parse(body) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      id = call.id ?? null;
      const params = call.params ?? {};
      if (call.method === "send_tx") {
        return json(response, 200, { jsonrpc: "2.0", id, ...sendTx(params) });
      }
      if (call.method === "block") {
        return json(response, 200, {
          jsonrpc: "2.0",
          id,
          result: { header: { hash: BLOCK_HASH, height: 1 } },
        });
      }
      if (params.request_type === "view_access_key") {
        const key = String(params.public_key);
        if (params.account_id !== OWNER_ACCOUNT) {
          return json(response, 200, {
            jsonrpc: "2.0",
            id,
            error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} } },
          });
        }
        return json(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            nonce: nonces.get(key) ?? 1000,
            permission: {
              FunctionCall: {
                allowance: "250000000000000000000000",
                receiver_id: WEB_ENV.MORROW_VAULT_CONTRACT,
                method_names: [],
              },
            },
            block_hash: BLOCK_HASH,
            block_height: 1,
          },
        });
      }
      const result = rpcResult(params);
      if (result === VAULT_NOT_FOUND) {
        return json(response, 200, { jsonrpc: "2.0", id, error: VAULT_NOT_FOUND_ERROR });
      }
      if (result === null) {
        return json(response, 200, { jsonrpc: "2.0", id, error: { name: "UNKNOWN_REQUEST" } });
      }
      json(response, 200, { jsonrpc: "2.0", id, result });
    } catch {
      json(response, 400, { jsonrpc: "2.0", id, error: { name: "PARSE_ERROR" } });
    }
  });
});

const watcher = createServer((request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, null);
  if (request.method === "GET" && request.url === "/heartbeat") {
    return json(response, 200, {
      last_seq: "41",
      last_block_timestamp: null,
      updated_at: new Date(Date.now() - STUB_HEARTBEAT_AGE_MS).toISOString(),
    });
  }
  json(response, 404, { error: "not found" });
});

const backend = createServer((request, response) => {
  if (request.method === "GET" && request.url === `/address/${VAULT_ADDRESS}/utxo`) {
    return json(response, 200, [
      { txid: ROUND.funding_txid, vout: 0, value: VAULT_SATS, status: { confirmed: true } },
    ]);
  }
  if (request.method === "GET" && request.url === `/address/${PROOF_VAULT_ADDRESS}/utxo`) {
    return json(response, 200, []);
  }
  if (request.method === "GET" && request.url === "/blocks/tip/height") {
    response.writeHead(200, { ...CORS, "content-type": "text/plain" });
    return response.end(String(TIP_HEIGHT));
  }
  json(response, 404, { error: "not found" });
});

const extra: Record<string, unknown>[] = [];

const challenge = createServer((request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, null);
  if (request.method === "GET" && request.url === "/round") return json(response, 200, ROUND);
  if (request.method === "GET" && request.url === "/attempts") {
    // Times follow the clock (the pending request stays 6 of 24 h along); row keys
    // (round and n) never change.
    const feed = attemptsAt(Date.now());
    return json(response, 200, {
      entries: [...extra].reverse().concat(feed.entries),
      summary: {
        ...feed.summary,
        attempts_round: feed.summary.attempts_round + extra.length,
        attempts_total: feed.summary.attempts_total + extra.length,
      },
    });
  }
  if (request.method === "POST" && request.url === "/__attempt") {
    void readBody(request).then((body) => {
      const tie = (body === "" ? {} : JSON.parse(body)) as {
        op_id?: string;
        clawback_txid?: string;
        clawback_broadcast?: boolean;
      };
      const n = 4 + extra.length;
      const now = Date.now();
      extra.push({
        type: "withdrawal",
        round: ROUND_NUMBER,
        n,
        seq: String(100 + n),
        vault_id: VAULT_ID,
        op_id: tie.op_id ?? String(100 + n),
        amount_sats: "10000",
        destination: "tb1qthief",
        requested_at: `${now - 30_000}000000`,
        executable_at: `${now + 86_370_000}000000`,
        time: new Date(now - 30_000).toISOString(),
        outcome: "clawed_back",
        outcome_at: `${now - 18_000}000000`,
        outcome_time: new Date(now - 18_000).toISOString(),
        clawback_op_id: String(200 + n),
        clawback_txid: tie.clawback_txid ?? null,
        clawback_broadcast: tie.clawback_broadcast ?? false,
        tx_hash: `9pNewAttempt${n}`,
      });
      json(response, 200, { n });
    });
    return;
  }
  json(response, 404, { error: "not found" });
});

rpc.listen(RPC_PORT, "127.0.0.1");
backend.listen(BACKEND_PORT, "127.0.0.1");
watcher.listen(WATCHER_PORT, "127.0.0.1");
challenge.listen(CHALLENGE_PORT, "127.0.0.1");

const stop = () => {
  for (const server of [rpc, backend, watcher, challenge]) server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
