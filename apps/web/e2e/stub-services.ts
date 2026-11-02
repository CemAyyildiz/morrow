// Local stand-ins for the three services the page may reach, for the e2e run only:
// `node e2e/stub-services.ts`. The NEAR RPC answers `view_access_key_list` with one
// function-call key (a locked contract), the watcher answers `/heartbeat` with a heartbeat
// one minute old, and the Bitcoin backend answers 404 (no screen reads it yet).
import { createServer, type ServerResponse } from "node:http";
import {
  BACKEND_PORT,
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
  response.end(JSON.stringify(body));
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
      if (
        call.params?.request_type !== "view_access_key_list" ||
        call.params.account_id !== WEB_ENV.MORROW_VAULT_CONTRACT
      ) {
        return json(response, 200, { jsonrpc: "2.0", id, error: { name: "UNKNOWN_REQUEST" } });
      }
    } catch {
      return json(response, 400, { jsonrpc: "2.0", id, error: { name: "PARSE_ERROR" } });
    }
    json(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
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
      },
    });
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

const backend = createServer((_request, response) => json(response, 404, { error: "not found" }));

rpc.listen(RPC_PORT, "127.0.0.1");
backend.listen(BACKEND_PORT, "127.0.0.1");
watcher.listen(WATCHER_PORT, "127.0.0.1");

const stop = () => {
  for (const server of [rpc, backend, watcher]) server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
