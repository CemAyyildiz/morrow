import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_VAULT_STORAGE_YOCTO,
  MockContractClient,
  presetPolicy,
  type MorrowEvent,
} from "@morrow/core-ts";
import { afterEach, describe, expect, it } from "vitest";
import { NearFinalBlockClock } from "./clock.js";
import { createHeartbeatServer } from "./heartbeat.js";
import { createLogger, redact } from "./log.js";
import { EventLoop, type EventHandler } from "./loop.js";
import { FileStore, InMemoryStore, type WatcherStore } from "./store.js";

const OWNER = "owner.test.near";
const ENVELOPE = "ab".repeat(80);
const silent = createLogger("test", () => undefined);

/** A mock contract with one Vault plus `requests` withdrawal requests (2 + requests events). */
async function contractWithEvents(requests: number) {
  const client = new MockContractClient().asCaller(OWNER);
  const vaultId = await client.createVault({
    owner_key: `02${"11".repeat(32)}`,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
    policy: presetPolicy("standard", {
      plannedDepositSats: 1_000_000n,
      guardians: [
        {
          guardian_key: `03${"22".repeat(32)}`,
          guardian_account: "emma.test.near",
          kind: "backup_device",
        },
      ],
      recoveryAddress: `tb1qrcvry${"q".repeat(33)}`,
      network: "signet",
      watcherX25519Pk: "44".repeat(32),
    }),
  });
  for (let i = 0; i < requests; i++) {
    await client.requestWithdrawal({
      vault_id: vaultId,
      amount_sats: "1000",
      destination: `tb1qdstn${"p".repeat(34)}`,
      fee_rate_sat_vb: 1,
      utxos: [{ txid: (i + 1).toString(16).padStart(64, "0"), vout: 0, value_sats: "100000" }],
      envelope: ENVELOPE,
    });
  }
  return client;
}

class RecordingHandler implements EventHandler {
  readonly calls: string[] = [];
  constructor(
    readonly name: string,
    private readonly failOnSeq: string | null = null,
  ) {}
  async handle(event: MorrowEvent): Promise<void> {
    if (event.seq === this.failOnSeq) throw new Error("boom");
    this.calls.push(event.seq);
  }
}

const loopFor = (
  client: MockContractClient,
  store: WatcherStore,
  handlers: EventHandler[],
  batchSize?: number,
) =>
  new EventLoop({
    client,
    store,
    handlers,
    clock: { now: async () => client.now() },
    log: silent,
    ...(batchSize === undefined ? {} : { batchSize }),
  });

describe("EventLoop", () => {
  it("delivers each event once, in order, and advances the cursor", async () => {
    const client = await contractWithEvents(5);
    const store = new InMemoryStore();
    const a = new RecordingHandler("a");
    const b = new RecordingHandler("b");
    expect(await loopFor(client, store, [a, b]).tick()).toBe(7);
    expect(a.calls).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(b.calls).toEqual(a.calls);
    expect((await store.progress()).cursor).toBe("7");
    expect(await loopFor(client, store, [a, b]).tick()).toBe(0);
  });

  it("pages through more events than one batch without gaps", async () => {
    const client = await contractWithEvents(248);
    const handler = new RecordingHandler("a");
    const store = new InMemoryStore();
    expect(await loopFor(client, store, [handler], 100).tick()).toBe(250);
    expect(handler.calls.map(Number)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });

  it("stops at a failing handler and retries the same event on the next tick", async () => {
    const client = await contractWithEvents(5);
    const store = new InMemoryStore();
    const flaky = new RecordingHandler("flaky", "3");
    expect(await loopFor(client, store, [flaky]).tick()).toBe(2);
    expect((await store.progress()).cursor).toBe("2");
    expect(flaky.calls).toEqual(["1", "2"]);
    const healed = new RecordingHandler("flaky");
    await loopFor(client, store, [healed]).tick();
    expect(healed.calls).toEqual(["3", "4", "5", "6", "7"]);
  });

  it("never misses or repeats a handler when it crashes at any persisted boundary", async () => {
    const client = await contractWithEvents(3); // 5 events, 2 handlers: 15 persisted writes
    for (let crashAfter = 1; crashAfter <= 15; crashAfter++) {
      const inner = new InMemoryStore();
      let writes = 0;
      const crashing: WatcherStore = {
        progress: () => inner.progress(),
        isHandled: (seq, handler) => inner.isHandled(seq, handler),
        markHandled: async (seq, handler) => {
          await inner.markHandled(seq, handler);
          if (++writes === crashAfter) throw new Error("crash");
        },
        commit: async (seq, ts) => {
          await inner.commit(seq, ts);
          if (++writes === crashAfter) throw new Error("crash");
        },
      };
      const a = new RecordingHandler("a");
      const b = new RecordingHandler("b");
      await expect(loopFor(client, crashing, [a, b]).tick()).rejects.toThrow("crash");
      await loopFor(client, inner, [a, b]).tick(); // restart from the same persisted state
      expect(a.calls, `crash after write ${crashAfter}`).toEqual(["1", "2", "3", "4", "5"]);
      expect(b.calls, `crash after write ${crashAfter}`).toEqual(["1", "2", "3", "4", "5"]);
    }
  });
});

describe("FileStore", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("persists progress and marks across instances", async () => {
    dir = await mkdtemp(join(tmpdir(), "morrow-watcher-"));
    const path = join(dir, "state.json");
    const first = new FileStore(path);
    await first.markHandled("8", "alerts");
    await first.commit("7", "123");
    const second = new FileStore(path);
    expect(await second.progress()).toMatchObject({ cursor: "7", last_block_timestamp: "123" });
    expect(await second.isHandled("8", "alerts")).toBe(true);
    await second.commit("8", "124");
    expect(await new FileStore(path).isHandled("8", "alerts")).toBe(false);
  });
});

describe("NearFinalBlockClock", () => {
  it("returns the final block timestamp in nanoseconds", async () => {
    let body = "";
    const clock = new NearFinalBlockClock("https://rpc.testnet.near.org", (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({ result: { header: { timestamp_nanosec: "1762070400123456789" } } }),
      );
    }) as typeof fetch);
    expect(await clock.now()).toBe(1762070400123456789n);
    expect(JSON.parse(body)).toMatchObject({ method: "block", params: { finality: "final" } });
  });

  it("throws on an RPC error", async () => {
    const clock = new NearFinalBlockClock(
      "https://rpc",
      (async () =>
        new Response(JSON.stringify({ error: { message: "unavailable" } }), {
          status: 503,
        })) as typeof fetch,
    );
    await expect(clock.now()).rejects.toThrow(/unavailable/);
  });
});

describe("heartbeat", () => {
  it("serves progress on GET /heartbeat and 404 elsewhere", async () => {
    const client = await contractWithEvents(5);
    const store = new InMemoryStore();
    await loopFor(client, store, []).tick();
    const server = createHeartbeatServer(store).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/heartbeat`);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const heartbeat = (await response.json()) as Record<string, unknown>;
      expect(heartbeat.last_seq).toBe("7");
      expect(heartbeat.last_block_timestamp).toBe(client.now().toString());
      expect(typeof heartbeat.updated_at).toBe("string");
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("logging", () => {
  it("writes JSON lines and redacts sensitive fields at any depth", () => {
    const lines: string[] = [];
    const log = createLogger("watcher", (line) => lines.push(line));
    log("info", "clawback", {
      vault_id: "1",
      guardian_key: "secret!",
      nested: { envelope: "ab", ok: 1 },
    });
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      component: "watcher",
      vault_id: "1",
      msg: "clawback",
    });
    expect(entry.guardian_key).toBe("[redacted]");
    expect(entry.nested).toEqual({ envelope: "[redacted]", ok: 1 });
    expect(redact({ telegram_token: "x" })).toEqual({ telegram_token: "[redacted]" });
  });
});
