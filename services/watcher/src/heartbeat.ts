import { createServer, type Server } from "node:http";
import type { WatcherStore } from "./store.js";

export interface Heartbeat {
  last_seq: string;
  last_block_timestamp: string | null;
  updated_at: string | null;
}

export async function readHeartbeat(store: WatcherStore): Promise<Heartbeat> {
  const progress = await store.progress();
  return {
    last_seq: progress.cursor,
    last_block_timestamp: progress.last_block_timestamp,
    updated_at: progress.updated_at,
  };
}

/** Public, read-only heartbeat: GET /heartbeat. Everything else is 404. */
export function createHeartbeatServer(store: WatcherStore): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET" || path !== "/heartbeat") {
      response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    readHeartbeat(store).then(
      (heartbeat) => {
        response
          .writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
          })
          .end(JSON.stringify(heartbeat));
      },
      () =>
        response
          .writeHead(503, { "content-type": "application/json" })
          .end('{"error":"unavailable"}'),
    );
  });
}
