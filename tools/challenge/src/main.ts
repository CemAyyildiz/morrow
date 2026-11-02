/**
 * Rob This Vault operator CLI (signet).
 *
 *   open [--next]   check the Policy, then create, fund and persist one round
 *   status          the latest round (published fields and progress; never operator keys)
 *   serve           GET /round and GET /attempts for the challenge page
 *   run             the round loop (next round, rotation, top-up, key rotation, rejected
 *                   attempts) every 30 s, serving GET /round and GET /attempts; the only writer
 */
import { FastNearLocator, FetchNearRpc, backendFromUrl } from "@morrow/core-ts";
import { FileAttemptStore } from "./attempts.js";
import { loadBaseConfig, loadNearConfig, loadPolicyConfig, loadRunConfig } from "./config.js";
import { createLogger } from "./log.js";
import { nearRound } from "./near.js";
import { RoundRunner } from "./run.js";
import { watcherClient } from "./watcher-client.js";
import { RecoveryWallet } from "./recovery-wallet.js";
import { assertRoundPolicy, buildRoundPolicy, openRound, roundExpectations } from "./round.js";
import { createRoundServer } from "./serve.js";
import { FileRoundStore, acquireStateLock, publicRound, type RoundRecord } from "./store.js";

const summary = (round: RoundRecord) => ({
  ...publicRound(round),
  status: round.status,
  failed_step: round.failed_step,
  last_error: round.last_error,
  allowance_address: round.allowance_address,
  funding_height: round.funding_height,
});

async function main(argv: string[]): Promise<void> {
  const [command, ...flags] = argv;
  const base = loadBaseConfig();
  const store = new FileRoundStore(base.stateFile);
  const backend = backendFromUrl(base.btcBackendUrl);

  if (command === "open") {
    const unknown = flags.filter((f) => f !== "--next");
    if (unknown.length > 0) throw new Error(`Unknown flag ${unknown.join(" ")}`);
    const policyConfig = loadPolicyConfig();
    const wallet = new RecoveryWallet(policyConfig.recoveryKey, backend, policyConfig.feeRate);
    const policy = {
      guardianAccount: policyConfig.guardianAccount,
      guardianKey: policyConfig.guardianKey,
      watcherX25519Pk: policyConfig.watcherX25519Pk,
      fundSats: policyConfig.fundSats,
      overrides: policyConfig.policyOverrides,
    };
    // The Policy is checked before any NEAR configuration or network call.
    const inputs = { ...policy, recoveryAddress: wallet.address };
    assertRoundPolicy(buildRoundPolicy(inputs), roundExpectations(inputs));
    const near = loadNearConfig();
    const lock = acquireStateLock(base.stateFile);
    const round = await openRound({
      store,
      near: nearRound(near),
      wallet,
      ownerParent: near.ownerParent,
      vaultContract: near.vaultContract,
      nearNetwork: near.nearNetwork,
      policy,
      next: flags.includes("--next"),
      progress: (line) => process.stderr.write(`${line}\n`),
    }).finally(() => lock.release());
    process.stdout.write(`${JSON.stringify(summary(round), null, 2)}\n`);
    return;
  }

  // status and serve are read-only: `run` (or `open`) is the only writer of the state file, and
  // `run` records the funding confirmation.
  if (command === "status") {
    const round = await store.latest();
    if (!round) throw new Error("No round yet: run open");
    process.stdout.write(`${JSON.stringify(summary(round), null, 2)}\n`);
    return;
  }

  if (command === "serve") {
    const attempts = new FileAttemptStore(base.attemptsFile);
    const server = createRoundServer(store, attempts).listen(base.port, () => {
      process.stderr.write(`challenge round server listening on :${base.port}\n`);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        server.close();
        process.exit(0);
      });
    }
    return;
  }

  if (command === "run") {
    const policyConfig = loadPolicyConfig();
    const wallet = new RecoveryWallet(policyConfig.recoveryKey, backend, policyConfig.feeRate);
    const policy = {
      guardianAccount: policyConfig.guardianAccount,
      guardianKey: policyConfig.guardianKey,
      watcherX25519Pk: policyConfig.watcherX25519Pk,
      fundSats: policyConfig.fundSats,
      overrides: policyConfig.policyOverrides,
    };
    const inputs = { ...policy, recoveryAddress: wallet.address };
    const roundPolicy = buildRoundPolicy(inputs);
    assertRoundPolicy(roundPolicy, roundExpectations(inputs));
    const nearConfig = loadNearConfig();
    const runConfig = loadRunConfig();
    acquireStateLock(base.stateFile); // released on exit
    const log = createLogger("challenge-run");
    const near = nearRound(nearConfig);
    const attempts = new FileAttemptStore(base.attemptsFile);
    const locator = new FastNearLocator({
      network: nearConfig.nearNetwork,
      maxPages: 5,
      ...(runConfig.fastnearTxUrl ? { baseUrl: runConfig.fastnearTxUrl } : {}),
      log: (line) => log("warn", line),
    });
    const rpc = new FetchNearRpc(runConfig.archivalRpcUrl ?? nearConfig.rpcUrl);
    const runner = new RoundRunner({
      store,
      attempts,
      near,
      backend,
      watcher: watcherClient({
        url: runConfig.watcherUrl,
        adminToken: runConfig.watcherAdminToken,
      }),
      sources: {
        signedBy: (accountId, isKnown) => locator.signedBy(accountId, isKnown),
        txStatus: (hash, senderId) => rpc.txStatus(hash, senderId),
      },
      openNext: () =>
        openRound({
          store,
          near,
          wallet,
          ownerParent: nearConfig.ownerParent,
          vaultContract: nearConfig.vaultContract,
          nearNetwork: nearConfig.nearNetwork,
          policy,
          next: true,
          progress: (line) => log("info", line),
        }),
      rotationMarginBlocks: runConfig.rotationMarginBlocks,
      nextEscapeTimelockBlocks: roundPolicy.escape_timelock_blocks,
      log,
    });
    const server = createRoundServer(store, attempts).listen(base.port, () => {
      log("info", `challenge round loop serving on :${base.port}`);
    });
    const loop = runner.start();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        server.close();
        void loop.stop().finally(() => process.exit(0));
      });
    }
    return;
  }

  throw new Error("Usage: challenge open [--next] | status | serve | run");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
