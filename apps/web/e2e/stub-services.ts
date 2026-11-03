// Local stand-ins for the services the page may reach, for the e2e run only:
// `node e2e/stub-services.ts`.
// - NEAR RPC: `view_access_key_list` of the contract with one function-call key (a locked
//   contract), `call_function get_vault` (Delay and Owner Account) and the signer's `state`
//   (threshold 11 of 16).
// - Watcher: `/heartbeat`, one minute old.
// - Bitcoin backend: the challenge Vault's UTXOs and the tip height; 404 otherwise.
// - Challenge feed (`tools/challenge run`): `GET /round` and `GET /attempts` from
//   challenge-fixture.ts. `POST /__attempt` appends a clawed-back attempt, so a spec can see a
//   new row arrive.
import { createServer, type ServerResponse } from "node:http";
import {
  DELAY_NS,
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
  if (params?.request_type !== "call_function") return null;
  const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString()) as {
    vault_id?: string;
  };
  if (
    params.account_id === WEB_ENV.MORROW_VAULT_CONTRACT &&
    params.method_name === "get_vault" &&
    args.vault_id === VAULT_ID
  ) {
    return viewResult({
      vault_id: VAULT_ID,
      owner_account: OWNER_ACCOUNT,
      state: "active",
      policy: { delay_ns: DELAY_NS, escape_timelock_blocks: 1000, btc_network: "signet" },
    });
  }
  if (params.account_id === "v1.signer-prod.testnet" && params.method_name === "state") {
    return viewResult(SIGNER_STATE);
  }
  return null;
}

const rpc = createServer((request, response) => {
  if (request.method === "OPTIONS") return json(response, 204, null);
  let body = "";
  request.on("data", (chunk: Buffer) => (body += String(chunk)));
  request.on("end", () => {
    let id: unknown = null;
    try {
      const call = JSON.parse(body) as { id?: unknown; params?: Record<string, unknown> };
      id = call.id ?? null;
      const result = rpcResult(call.params);
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
    const n = 4 + extra.length;
    const now = Date.now();
    extra.push({
      type: "withdrawal",
      round: ROUND_NUMBER,
      n,
      seq: String(100 + n),
      vault_id: VAULT_ID,
      op_id: String(100 + n),
      amount_sats: "10000",
      destination: "tb1qthief",
      requested_at: `${now - 30_000}000000`,
      executable_at: `${now + 86_370_000}000000`,
      time: new Date(now - 30_000).toISOString(),
      outcome: "clawed_back",
      outcome_at: `${now - 18_000}000000`,
      outcome_time: new Date(now - 18_000).toISOString(),
      clawback_op_id: String(200 + n),
      clawback_txid: null,
      clawback_broadcast: false,
      tx_hash: `9pNewAttempt${n}`,
    });
    return json(response, 200, { n });
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
