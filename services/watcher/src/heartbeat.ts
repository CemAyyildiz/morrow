import { createServer, type IncomingMessage, type Server } from "node:http";
import type { WatcherStore } from "./store.js";
import type { LinkRole, LinkStore } from "./telegram/links.js";

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

export interface LinkingOptions {
  links: LinkStore;
  botUsername: string;
}

const MAX_BODY_BYTES = 4_096;

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_BODY_BYTES) throw new Error("body too large");
  }
  return JSON.parse(body);
}

/**
 * The watcher's public HTTP API: `GET /heartbeat` and, when Telegram is configured,
 * `POST /link-codes {vault_id, account_id, role}` → `{code, deep_link}`. Everything else is 404.
 */
export function createApiServer(store: WatcherStore, linking?: LinkingOptions): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const json = (status: number, body: unknown) =>
      response
        .writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type",
        })
        .end(JSON.stringify(body));

    if (request.method === "OPTIONS") return json(204, null);
    if (request.method === "GET" && path === "/heartbeat") {
      readHeartbeat(store).then(
        (heartbeat) => json(200, heartbeat),
        () => json(503, { error: "unavailable" }),
      );
      return;
    }
    if (request.method === "POST" && path === "/link-codes" && linking) {
      readJson(request)
        .then(async (body) => {
          const { vault_id, account_id, role } = (body ?? {}) as Record<string, unknown>;
          const validRole = role === "owner" || role === "guardian";
          if (
            typeof vault_id !== "string" ||
            !/^\d+$/.test(vault_id) ||
            typeof account_id !== "string" ||
            !validRole
          ) {
            return json(400, { error: "expected {vault_id, account_id, role: owner|guardian}" });
          }
          const code = await linking.links.createCode(vault_id, account_id, role as LinkRole);
          return json(201, {
            code,
            deep_link: `https://t.me/${linking.botUsername}?start=${code}`,
          });
        })
        .catch(() => json(400, { error: "invalid JSON" }));
      return;
    }
    json(404, { error: "not found" });
  });
}

/** Heartbeat-only server (no linking). */
export function createHeartbeatServer(store: WatcherStore): Server {
  return createApiServer(store);
}
