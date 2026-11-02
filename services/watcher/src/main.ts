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
import { createApiServer } from "./heartbeat.js";
import { createLogger } from "./log.js";
import { EventLoop, type EventHandler } from "./loop.js";
import { FileStore } from "./store.js";
import { TelegramBot } from "./telegram/bot.js";
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
  bot = new TelegramBot(config.telegramToken, links, log);
  botUsername = await bot.username();
  handlers.push(
    new AlertsHandler({
      links,
      sender: bot,
      appUrl: config.appUrl,
      getOp: (id) => client.getOp(id),
    }),
  );
  bot.start();
} else {
  log("warn", "MORROW_TELEGRAM_BOT_TOKEN not set: alerts are disabled");
}

// The frozen-op index has its own loop and cursor, so it backfills from seq 0 when the jobs
// file is new and a broken jobs file never stalls alerts. It runs even without a Guardian.
const jobs = new FileJobStore(config.jobsFile);
const indexLoop = new EventLoop({
  client,
  store: new FileStore(
    join(dirname(config.jobsFile), `${basename(config.jobsFile, ".json")}.index-cursor.json`),
  ),
  handlers: [new ClawbackIndexHandler(jobs)],
  clock,
  log,
  intervalMs: config.pollIntervalMs,
});
let runner: ClawbackRunner | null = null;
let challengeLoop: EventLoop | null = null;
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
      store: new FileStore(
        join(
          dirname(config.jobsFile),
          `${basename(config.jobsFile, ".json")}.challenge-cursor.json`,
        ),
      ),
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
} else {
  log("warn", "Guardian account and keys not set: Auto-Clawback is disabled");
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
createApiServer(store, bot ? { links, botUsername } : undefined, clawbackApi).listen(
  config.port,
  () => {
    log("info", "watcher listening", {
      port: config.port,
      contract: config.vaultContract,
      network: config.nearNetwork,
    });
  },
);
loop.start();
challengeLoop?.start();
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
    runner?.stop();
    void bot?.stop();
    log("info", "stopped", { signal });
    process.exit(0);
  });
}
