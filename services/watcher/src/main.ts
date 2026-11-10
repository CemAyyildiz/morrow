import { basename, dirname, join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  MockContractClient,
  NearContractClient,
  backendFromUrl,
  bytesToHex,
  hexToBytes,
  type ContractClient,
} from "@morrow/core-ts";
import { ChallengeHandler } from "./challenge/handler.js";
import { ClawbackIndexHandler } from "./clawback/index-handler.js";
import { FileJobStore } from "./clawback/jobs.js";
import { ClawbackRunner, guardianBroadcaster } from "./clawback/runner.js";
import { NearFinalBlockClock, type ChainClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { DuressHandler } from "./duress/handler.js";
import { duressHealth } from "./duress/health.js";
import { FileDuressStore } from "./duress/store.js";
import { LooseningGuard, envelopeKeypair } from "./guard/handler.js";
import { guardHealth } from "./guard/health.js";
import { FileGuardStore } from "./guard/store.js";
import { GuardTicker } from "./guard/ticker.js";
import { createApiServer, type DuressHealthSource, type GuardHealthSource } from "./heartbeat.js";
import { createLogger } from "./log.js";
import { EventLoop, type EventHandler } from "./loop.js";
import { FileStore } from "./store.js";
import { TelegramBot } from "./telegram/bot.js";
import { OwnerConfirmation } from "./telegram/confirm.js";
import { AlertsHandler } from "./telegram/handler.js";
import { FileLinkStore } from "./telegram/links.js";

const log = createLogger("watcher");
const config = loadConfig();

let client: ContractClient;
let clock: ChainClock;
/** Builds the Guardian-signed client for begin_clawback, sign_input and veto_policy_change. */
let guardianClient: (accountId: string, secretKey: string) => ContractClient;
if (config.nearNetwork === "mock" || !config.nearRpcUrl) {
  const mock = new MockContractClient();
  client = mock;
  clock = { now: async () => mock.now() };
  guardianClient = (accountId) => mock.asCaller(accountId);
} else {
  const rpcUrl = config.nearRpcUrl;
  client = new NearContractClient({ contractId: config.vaultContract, rpcUrl });
  clock = new NearFinalBlockClock(rpcUrl);
  guardianClient = (accountId, secretKey) =>
    new NearContractClient({
      contractId: config.vaultContract,
      rpcUrl,
      signer: { accountId, secretKey },
    });
}

const store = new FileStore(config.stateFile);
const links = new FileLinkStore(config.linksFile);
const handlers: EventHandler[] = [];
let bot: TelegramBot | null = null;
let botUsername = "";

if (config.telegramToken) {
  bot = new TelegramBot(config.telegramToken, links, log, clock);
  botUsername = await bot.username();
  handlers.push(
    new AlertsHandler({
      links,
      sender: bot,
      appUrl: config.appUrl,
      getOp: (id) => client.getOp(id),
      clock,
    }),
  );
} else {
  log("warn", "MORROW_TELEGRAM_BOT_TOKEN not set: alerts are disabled");
}

// The frozen-op index has its own loop and cursor, so it backfills from seq 0 when the jobs
// file is new and a broken jobs file never stalls alerts. It runs even without a Guardian.
const jobs = new FileJobStore(config.jobsFile);
/** `<jobs>.<suffix>.json`, next to the jobs file. */
const besideJobs = (suffix: string) =>
  join(dirname(config.jobsFile), `${basename(config.jobsFile, ".json")}.${suffix}.json`);
const indexLoop = new EventLoop({
  client,
  store: new FileStore(besideJobs("index-cursor")),
  handlers: [new ClawbackIndexHandler(jobs)],
  clock,
  log,
  intervalMs: config.pollIntervalMs,
});
let runner: ClawbackRunner | null = null;
let challengeLoop: EventLoop | null = null;
let guardLoop: EventLoop | null = null;
let guardTicker: GuardTicker | null = null;
let guardHealthSource: GuardHealthSource | undefined;
let duressLoop: EventLoop | null = null;
let duressHealthSource: DuressHealthSource | undefined;
/** Owner Confirmation (5.3b); set once the bot and, when configured, the guard exist. */
let confirmation: OwnerConfirmation | null = null;
let linkTimer: ReturnType<typeof setInterval> | null = null;
if (config.guardian) {
  const backend = backendFromUrl(config.btcBackendUrl);
  const guardianSigner = guardianClient(config.guardian.accountId, config.guardian.nearKey);
  runner = new ClawbackRunner({
    reader: client,
    signer: guardianSigner,
    guardianAccount: config.guardian.accountId,
    guardianKey: bytesToHex(secp256k1.getPublicKey(hexToBytes(config.guardian.btcKey), true)),
    backend,
    broadcastSigned: guardianBroadcaster(client, backend, hexToBytes(config.guardian.btcKey)),
    jobs,
    clock,
    log,
    baseFeeRate: config.clawbackFeeRate,
    intervalMs: config.pollIntervalMs,
  });
  if (!config.adminToken) {
    log("warn", "MORROW_WATCHER_ADMIN_TOKEN not set: POST /clawbacks is disabled");
  }
  if (config.challengeOwnerParent) {
    // Own loop and cursor, so a veto that keeps failing never stalls alerts.
    const challengeRunner = runner;
    challengeLoop = new EventLoop({
      client,
      store: new FileStore(besideJobs("challenge-cursor")),
      handlers: [
        new ChallengeHandler({
          reader: client,
          signer: guardianSigner,
          ownerParent: config.challengeOwnerParent,
          enqueue: (vaultId, trigger) => challengeRunner.enqueue(vaultId, trigger),
        }),
      ],
      clock,
      log,
      intervalMs: config.pollIntervalMs,
    });
    log("info", "challenge mode on", { owner_parent: config.challengeOwnerParent });
  }

  // Loosening guard: its own loop and cursor, so a veto that keeps failing never stalls alerts or
  // clawbacks; the ticker sends each veto at effective_at − 65 min unless the Owner confirmed the
  // change from the active owner chat (5.3b), and delivers the confirmation requests.
  const guardCursor = new FileStore(besideJobs("guard-cursor"));
  // A corrupt guard file is moved aside and the schedule rebuilt from event 0 (first-sight rule).
  const guardStore = new FileGuardStore(besideJobs("guard"), {
    log,
    onCorrupt: () => guardCursor.reset(),
  });
  // Read once before the loops start, so a corrupt file is recovered before any event is handled.
  await guardStore.entries().catch(() => undefined);
  if (!config.watcherEnvelopeSecretKey) {
    log(
      "warn",
      "MORROW_WATCHER_X25519_SK not set: the loosening guard reads duress as unknown, and duress scheduling is off",
    );
  }
  guardLoop = new EventLoop({
    client,
    store: guardCursor,
    handlers: [
      new LooseningGuard({
        reader: client,
        guardianAccount: config.guardian.accountId,
        store: guardStore,
        envelopeKeypair: config.watcherEnvelopeSecretKey
          ? envelopeKeypair(config.watcherEnvelopeSecretKey)
          : null,
        challengeOwnerParent: config.challengeOwnerParent,
      }),
    ],
    clock,
    log,
    intervalMs: config.pollIntervalMs,
  });
  guardTicker = new GuardTicker({
    reader: client,
    signer: guardianSigner,
    store: guardStore,
    guardianAccount: config.guardian.accountId,
    clock,
    log,
    intervalMs: config.pollIntervalMs,
    // Without Telegram there is no owner chat: every loosening change is vetoed (fail-closed).
    requests: { request: async (entry, now) => confirmation?.request(entry, now) },
    envelopeKeyConfigured: config.watcherEnvelopeSecretKey !== null,
  });
  const ticker = guardTicker;
  if (bot) {
    confirmation = new OwnerConfirmation({
      links,
      sender: bot,
      reader: client,
      clock,
      log,
      guard: { store: guardStore, vetoNow: (changeId) => ticker.vetoNow(changeId) },
    });
  }
  guardHealthSource = guardHealth({
    cursor: guardCursor,
    store: guardStore,
    loop: guardLoop,
    ticker: guardTicker,
  });

  // Duress scheduling (8.2): needs the envelope key to read the flag, so it runs only with it (the
  // warning above covers its absence). Own loop and cursor; it queues `duress` jobs for the runner.
  if (config.watcherEnvelopeSecretKey) {
    const duressCursor = new FileStore(besideJobs("duress-cursor"));
    // A corrupt state file is moved aside and rebuilt from event 0, like the guard's.
    const duressStore = new FileDuressStore(besideJobs("duress"), {
      log,
      onCorrupt: () => duressCursor.reset(),
    });
    await duressStore.vaults().catch(() => undefined);
    duressLoop = new EventLoop({
      client,
      store: duressCursor,
      handlers: [
        new DuressHandler({
          reader: client,
          guardianAccount: config.guardian.accountId,
          store: duressStore,
          jobs,
          envelopeKeypair: envelopeKeypair(config.watcherEnvelopeSecretKey),
          challengeOwnerParent: config.challengeOwnerParent,
        }),
      ],
      clock,
      log,
      intervalMs: config.pollIntervalMs,
    });
    duressHealthSource = duressHealth({ cursor: duressCursor, loop: duressLoop });
  }
} else {
  log(
    "warn",
    "Guardian account and keys not set: Auto-Clawback and the loosening guard are disabled",
  );
}

if (bot) {
  // Link buttons (Approve / Cancel) work even without the guard; Confirm and Reject need it.
  confirmation ??= new OwnerConfirmation({ links, sender: bot, reader: client, clock, log });
  bot.attach(confirmation);
  bot.start();
  // Link announcements, activation notices and re-link notices, retried until delivered.
  const linkActions = confirmation;
  let linkTicking = false;
  linkTimer = setInterval(() => {
    if (linkTicking) return;
    linkTicking = true;
    linkActions
      .tickLinks()
      .catch((error: unknown) =>
        log("error", "telegram link tick failed; will retry", {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => (linkTicking = false));
  }, config.pollIntervalMs);
}

const loop = new EventLoop({
  client,
  store,
  handlers,
  clock,
  log,
  intervalMs: config.pollIntervalMs,
});
const clawbackApi =
  runner && config.adminToken
    ? { adminToken: config.adminToken, enqueue: (vaultId: string) => runner.enqueue(vaultId) }
    : undefined;
createApiServer(
  store,
  bot ? { links, botUsername, reader: client, clock } : undefined,
  clawbackApi,
  guardHealthSource,
  duressHealthSource,
).listen(config.port, () => {
  log("info", "watcher listening", {
    port: config.port,
    contract: config.vaultContract,
    network: config.nearNetwork,
  });
});
loop.start();
challengeLoop?.start();
guardLoop?.start();
guardTicker?.start();
duressLoop?.start();
// The runner plans only once the index has caught up, or it could miss reserved or racing coins.
void (async () => {
  for (;;) {
    try {
      await indexLoop.tick();
      break;
    } catch (error) {
      log("error", "clawback index catch-up failed; will retry", {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
  indexLoop.start();
  runner?.start();
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    loop.stop();
    indexLoop.stop();
    challengeLoop?.stop();
    guardLoop?.stop();
    guardTicker?.stop();
    duressLoop?.stop();
    if (linkTimer) clearInterval(linkTimer);
    runner?.stop();
    void bot?.stop();
    log("info", "stopped", { signal });
    process.exit(0);
  });
}
