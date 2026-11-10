import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  MINUTE_NS,
  MorrowContractError,
  linkRequestProblems,
  verifyLinkRequest,
  type ContractClient,
  type LinkRequest,
} from "@morrow/core-ts";
import type { ClawbackJob } from "./clawback/jobs.js";
import type { ChainClock } from "./clock.js";
import type { WatcherStore } from "./store.js";
import type { LinkStore } from "./telegram/links.js";

/** Loosening-guard health: no change ids, reasons or flags. */
export interface GuardHealth {
  /** The guard loop's cursor. */
  cursor: string;
  /** Events the guard loop is behind the main loop's cursor (0 when it is ahead). */
  lag: string;
  /** Entries waiting for (or retrying) their veto. */
  scheduled: number;
  /** The last guard loop or ticker failure: an error code or class only. */
  last_error: { at: string; error: string } | null;
}

/**
 * Duress handler health: its loop's progress only. No Vault ids, flags or job counts, so the
 * heartbeat never tells that a Vault is in duress.
 */
export type DuressHealth = Omit<GuardHealth, "scheduled">;

export interface Heartbeat {
  last_seq: string;
  last_block_timestamp: string | null;
  updated_at: string | null;
  /** Present when the loosening guard runs. */
  guard?: GuardHealth;
  /** Present when the duress handler runs. */
  duress?: DuressHealth;
}

/** Reads the guard's health given the main loop's cursor. */
export type GuardHealthSource = (mainCursor: string) => Promise<GuardHealth>;

/** Reads the duress handler's health given the main loop's cursor. */
export type DuressHealthSource = (mainCursor: string) => Promise<DuressHealth>;

export async function readHeartbeat(
  store: WatcherStore,
  guard?: GuardHealthSource,
  duress?: DuressHealthSource,
): Promise<Heartbeat> {
  const progress = await store.progress();
  return {
    last_seq: progress.cursor,
    last_block_timestamp: progress.last_block_timestamp,
    updated_at: progress.updated_at,
    ...(guard ? { guard: await guard(progress.cursor) } : {}),
    ...(duress ? { duress: await duress(progress.cursor) } : {}),
  };
}

export interface LinkingOptions {
  links: LinkStore;
  botUsername: string;
  /** Reads `get_vault`, whose keys sign link requests. */
  reader: Pick<ContractClient, "getVault">;
  /** The latest final NEAR block time, for the `ts` window. */
  clock: ChainClock;
  /** Wall-clock nanoseconds, for the cheap `ts` pre-check before any RPC; default `Date.now()`. */
  wallNow?: () => bigint;
  /** Per-IP and per-Vault limits; `createApiServer` adds one when absent. */
  limiter?: RateLimiter;
}

/**
 * Fixed-window request counter per key, in memory: at most `limit` requests per `windowMs`.
 * Enough to stop a flood of `POST /link-codes` from turning into a flood of NEAR RPC calls.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts one request for every key; false when any key is over its limit. */
  allow(keys: string[], now = Date.now()): boolean {
    if (this.windows.size > 10_000) {
      for (const [key, w] of this.windows)
        if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
    let ok = true;
    for (const key of keys) {
      const current = this.windows.get(key);
      const w = current && now - current.start < this.windowMs ? current : { start: now, count: 0 };
      w.count++;
      this.windows.set(key, w);
      if (w.count > this.limit) ok = false;
    }
    return ok;
  }
}

/** The wall-clock pre-check allows this much more than the window, for clock drift. */
const WALL_CLOCK_SLACK_NS = 5n * MINUTE_NS;

/** A link request's `ts` must be this close to the final-block time. */
export const LINK_TS_WINDOW_NS = 10n * MINUTE_NS;

type LinkDecision =
  { ok: true; request: LinkRequest } | { ok: false; status: number; error: string };

/**
 * Checks a signed link request (R1): the fields, `ts` within ±10 min of the final-block time,
 * and the signature against the Vault's own key for the role: `owner_key` with `owner_account`,
 * or the named Guardian's `guardian_key`.
 */
export async function checkLinkRequest(
  body: unknown,
  linking: Pick<LinkingOptions, "reader" | "botUsername">,
  now: bigint,
): Promise<LinkDecision> {
  const shape = linkRequestShape(body, linking.botUsername);
  if (!shape.ok) return shape;
  const { request, signature } = shape;
  const skew = BigInt(request.ts) - now;
  if (skew > LINK_TS_WINDOW_NS || -skew > LINK_TS_WINDOW_NS) {
    return { ok: false, status: 401, error: "ts is not within 10 minutes of NEAR time" };
  }
  let vault;
  try {
    vault = await linking.reader.getVault(request.vault_id);
  } catch (error) {
    if (error instanceof MorrowContractError && error.code === "ERR_VAULT_NOT_FOUND") {
      return { ok: false, status: 404, error: "vault not found" };
    }
    throw error;
  }
  if (vault.state !== "active") return { ok: false, status: 409, error: "vault is not active" };
  const key =
    request.role === "owner"
      ? vault.owner_account === request.account_id
        ? vault.owner_key
        : null
      : (vault.policy.guardians.find((g) => g.guardian_account === request.account_id)
          ?.guardian_key ?? null);
  if (!key || !verifyLinkRequest(request, signature, key)) {
    return {
      ok: false,
      status: 401,
      error: "signature does not match the Vault's key for this role",
    };
  }
  return { ok: true, request };
}

/** The no-RPC part: the fields and the signature's format. The bot is this watcher's own. */
function linkRequestShape(
  body: unknown,
  botUsername: string,
):
  | { ok: true; request: LinkRequest; signature: string }
  | { ok: false; status: number; error: string } {
  const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { vault_id, role, account_id, ts, signature } = fields;
  const problems = linkRequestProblems({ bot: botUsername, vault_id, role, account_id, ts });
  if (typeof signature !== "string" || !/^[0-9a-f]{128}$/.test(signature)) {
    problems.push("signature must be 64-byte compact secp256k1 hex (r ‖ s, low-S)");
  }
  if (problems.length) {
    return {
      ok: false,
      status: 400,
      error: `expected {vault_id, role: owner|guardian, account_id, ts, signature}: ${problems.join("; ")}`,
    };
  }
  const request = { bot: botUsername, vault_id, role, account_id, ts } as LinkRequest;
  return { ok: true, request, signature: signature as string };
}

/** Manual Auto-Clawback trigger; only served when an admin token and a Guardian are configured. */
export interface ClawbackApiOptions {
  adminToken: string;
  enqueue(vaultId: string): Promise<ClawbackJob>;
}

const MAX_BODY_BYTES = 4_096;

/** Constant-time bearer token check (hashing first makes the lengths equal). */
function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return presented.length > 0 && timingSafeEqual(digest(presented), digest(token));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > MAX_BODY_BYTES) throw new Error("body too large");
  }
  return JSON.parse(body);
}

/**
 * `POST /link-codes`: checks the signed request (`checkLinkRequest`), uses up its nonce and
 * issues a code. Throws when NEAR or the store is unavailable.
 */
export async function issueLinkCode(
  body: unknown,
  linking: LinkingOptions,
  ip?: string,
): Promise<{ status: number; body: unknown }> {
  // Cheap checks first, so a flood never reaches NEAR: shape, rate limit, wall-clock window.
  const shape = linkRequestShape(body, linking.botUsername);
  if (!shape.ok) return { status: shape.status, body: { error: shape.error } };
  const keys = [`vault:${shape.request.vault_id}`, ...(ip ? [`ip:${ip}`] : [])];
  if (linking.limiter && !linking.limiter.allow(keys)) {
    return { status: 429, body: { error: "too many link requests; try again in a minute" } };
  }
  const wall = linking.wallNow?.() ?? BigInt(Date.now()) * 1_000_000n;
  const drift = BigInt(shape.request.ts) - wall;
  if (
    drift > LINK_TS_WINDOW_NS + WALL_CLOCK_SLACK_NS ||
    -drift > LINK_TS_WINDOW_NS + WALL_CLOCK_SLACK_NS
  ) {
    return { status: 401, body: { error: "ts is not within 10 minutes of NEAR time" } };
  }
  const now = await linking.clock.now();
  const decision = await checkLinkRequest(body, linking, now);
  if (!decision.ok) return { status: decision.status, body: { error: decision.error } };
  const { vault_id, role, account_id, ts } = decision.request;
  // The nonce covers this watcher only: the bot is part of the signed message.
  const code = await linking.links.createCode(
    { vault_id, role, account_id },
    { key: `${vault_id}:${role}:${account_id}:${ts}`, expiresAt: BigInt(ts) + LINK_TS_WINDOW_NS },
    now,
  );
  if (!code) return { status: 409, body: { error: "this signed request was already used" } };
  return {
    status: 201,
    body: { code, deep_link: `https://t.me/${linking.botUsername}?start=${code}` },
  };
}

/**
 * The watcher's public HTTP API: `GET /heartbeat`; when Telegram is configured,
 * `POST /link-codes {vault_id, role, account_id, ts, signature}` (signed over this watcher's bot
 * username, single-use, rate-limited per IP and per Vault, 429 on excess; see `checkLinkRequest`)
 * → `{code, deep_link}`; when Auto-Clawback and an
 * admin token are configured, `POST /clawbacks {vault_id}` with `Authorization: Bearer <token>`
 * → 202 `{job_id, vault_id, status}`. Everything else is 404.
 */
export function createApiServer(
  store: WatcherStore,
  linking?: LinkingOptions,
  clawbacks?: ClawbackApiOptions,
  guard?: GuardHealthSource,
  duress?: DuressHealthSource,
): Server {
  const linkingWithLimit = linking && { limiter: new RateLimiter(), ...linking };
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
      readHeartbeat(store, guard, duress).then(
        (heartbeat) => json(200, heartbeat),
        () => json(503, { error: "unavailable" }),
      );
      return;
    }
    if (request.method === "POST" && path === "/link-codes" && linking) {
      readJson(request).then(
        (body) =>
          issueLinkCode(body, linkingWithLimit ?? linking, request.socket.remoteAddress).then(
            (result) => json(result.status, result.body),
            () => json(503, { error: "unavailable" }),
          ),
        () => json(400, { error: "invalid JSON" }),
      );
      return;
    }
    if (request.method === "POST" && path === "/clawbacks" && clawbacks) {
      if (!authorized(request, clawbacks.adminToken)) {
        request.resume();
        return json(401, { error: "unauthorized" });
      }
      readJson(request).then(
        (body) => {
          const { vault_id } = (body ?? {}) as Record<string, unknown>;
          if (typeof vault_id !== "string" || !/^\d+$/.test(vault_id)) {
            return json(400, { error: "expected {vault_id}" });
          }
          clawbacks.enqueue(vault_id).then(
            (job) => json(202, { job_id: job.job_id, vault_id: job.vault_id, status: job.status }),
            () => json(503, { error: "unavailable" }),
          );
        },
        () => json(400, { error: "invalid JSON" }),
      );
      return;
    }
    json(404, { error: "not found" });
  });
}

/** Heartbeat-only server (no linking). */
export function createHeartbeatServer(store: WatcherStore): Server {
  return createApiServer(store);
}
