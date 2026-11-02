import { MockContractClient, NearContractClient, type ContractClient } from "@morrow/core-ts";
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
if (config.nearNetwork === "mock" || !config.nearRpcUrl) {
  const mock = new MockContractClient();
  client = mock;
  clock = { now: async () => mock.now() };
} else {
  client = new NearContractClient({ contractId: config.vaultContract, rpcUrl: config.nearRpcUrl });
  clock = new NearFinalBlockClock(config.nearRpcUrl);
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

const loop = new EventLoop({
  client,
  store,
  handlers,
  clock,
  log,
  intervalMs: config.pollIntervalMs,
});
createApiServer(store, bot ? { links, botUsername } : undefined).listen(config.port, () => {
  log("info", "watcher listening", {
    port: config.port,
    contract: config.vaultContract,
    network: config.nearNetwork,
  });
});
loop.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    loop.stop();
    void bot?.stop();
    log("info", "stopped", { signal });
    process.exit(0);
  });
}
