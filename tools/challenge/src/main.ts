/**
 * Rob This Vault operator CLI (signet).
 *
 *   open [--next]   check the Policy, then create, fund and persist one round
 *   status          the latest round (published fields and progress; never operator keys)
 *   serve           GET /round for the challenge page
 */
import { backendFromUrl } from "@morrow/core-ts";
import { loadBaseConfig, loadNearConfig, loadPolicyConfig } from "./config.js";
import { nearRound } from "./near.js";
import { RecoveryWallet } from "./recovery-wallet.js";
import {
  assertRoundPolicy,
  buildRoundPolicy,
  openRound,
  refreshDeadline,
  roundExpectations,
} from "./round.js";
import { createRoundServer } from "./serve.js";
import { FileRoundStore, publicRound, type RoundRecord } from "./store.js";

const REFRESH_MS = 60_000;

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
    });
    process.stdout.write(`${JSON.stringify(summary(round), null, 2)}\n`);
    return;
  }

  if (command === "status") {
    await refreshDeadline(store, backend).catch((error: unknown) => {
      process.stderr.write(`could not check the funding confirmation: ${String(error)}\n`);
    });
    const round = await store.latest();
    if (!round) throw new Error("No round yet: run open");
    process.stdout.write(`${JSON.stringify(summary(round), null, 2)}\n`);
    return;
  }

  if (command === "serve") {
    const refresh = () =>
      refreshDeadline(store, backend).catch((error: unknown) => {
        process.stderr.write(`deadline refresh failed; will retry: ${String(error)}\n`);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const server = createRoundServer(store).listen(base.port, () => {
      process.stderr.write(`challenge round server listening on :${base.port}\n`);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        clearInterval(timer);
        server.close();
        process.exit(0);
      });
    }
    return;
  }

  throw new Error("Usage: challenge open [--next] | status | serve");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
