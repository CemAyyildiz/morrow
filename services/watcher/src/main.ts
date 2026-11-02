import { MockContractClient } from "@morrow/core-ts";
import { NearFinalBlockClock, type ChainClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createHeartbeatServer } from "./heartbeat.js";
import { createLogger } from "./log.js";
import { EventLoop } from "./loop.js";
import { FileStore } from "./store.js";

const log = createLogger("watcher");
const config = loadConfig();

if (config.nearNetwork !== "mock") {
  // The NEAR contract client arrives with the Vault Contract (Epic 2).
  log("error", "only MORROW_NEAR_NETWORK=mock is supported until the contract client lands");
  process.exit(1);
}

const client = new MockContractClient();
const clock: ChainClock = config.nearRpcUrl
  ? new NearFinalBlockClock(config.nearRpcUrl)
  : { now: async () => client.now() };
const store = new FileStore(config.stateFile);
const loop = new EventLoop({
  client,
  store,
  handlers: [],
  clock,
  log,
  intervalMs: config.pollIntervalMs,
});

createHeartbeatServer(store).listen(config.port, () => {
  log("info", "heartbeat listening", { port: config.port, contract: config.vaultContract });
});
loop.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    loop.stop();
    log("info", "stopped", { signal });
    process.exit(0);
  });
}
