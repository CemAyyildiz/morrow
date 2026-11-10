import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NearContractClient, bytesToHex } from "@morrow/core-ts";
import { afterWrite } from "../chain.js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

const ESCAPE_DIR = resolve(import.meta.dirname, "../../../escape");

/** Runs morrow-escape as a separate process with no NEAR or Morrow configuration at all. */
function runEscape(args: string[], ownerKeyHex: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: ESCAPE_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MORROW_OWNER_KEY: ownerKeyHex,
    },
    encoding: "utf8",
  });
  return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * S-5 Escape: with only the Vault Kit and the Owner Key, the coins leave the Vault after the
 * Escape Timelock. NEAR is not used, and with MORROW_KILL_NEAR=1 it is not even reachable.
 */
export async function runEscapeScenario(ctx: ScenarioContext): Promise<void> {
  const session = await judgeSession();
  const { client, config, regtest, rpc } = session;
  const { vaultId } = await createJudgeVault(session);
  const kit = await afterWrite("get_vault_kit", () => client.getVaultKit(vaultId));
  await regtest.fund(kit.addresses.vault, 1_000_000n);
  await regtest.mine(1);
  const [coin] = await rpc.getUtxos(kit.addresses.vault);
  if (!coin?.height) throw new Error("Vault coin not confirmed");
  ctx.log(`Vault ${vaultId} holds 0.01 BTC; Escape Timelock ${kit.escape_timelock_blocks} blocks`);

  const dir = mkdtempSync(join(tmpdir(), "morrow-escape-"));
  try {
    const kitFile = join(dir, "vault-kit.json");
    writeFileSync(kitFile, JSON.stringify(kit), { mode: 0o600 });
    ctx.log("Vault Kit saved; from here on NEAR is not used");

    if (process.env.MORROW_KILL_NEAR === "1") {
      const dead = new NearContractClient({
        contractId: config.vaultContract,
        rpcUrl: "http://127.0.0.1:9",
      });
      try {
        await dead.getVault(vaultId);
        throw new Error("NEAR was still reachable");
      } catch (error) {
        if (error instanceof Error && error.message === "NEAR was still reachable") throw error;
        ctx.log("NEAR is gone: the contract cannot be reached");
      }
    }

    const destination = await regtest.newAddress();
    const utxo = `${coin.txid}:${coin.vout}:${coin.value_sats}:${coin.height}`;
    const offline = (tip: number) =>
      runEscape(
        [
          "--kit",
          kitFile,
          "--to",
          destination,
          "--offline",
          "--height",
          String(tip),
          "--utxo",
          utxo,
        ],
        bytesToHex(session.ownerSecret),
      );

    const early = offline(await rpc.getTipHeight());
    if (early.code === 0) throw new Error("Escape succeeded before the timelock");
    ctx.log(`Before the timelock morrow-escape refuses: ${early.stderr.split("\n").pop() ?? ""}`);

    await regtest.mine(kit.escape_timelock_blocks);
    const ready = offline(await rpc.getTipHeight());
    if (ready.code !== 0) throw new Error(`morrow-escape failed: ${ready.stderr}`);
    ctx.log("morrow-escape --offline signed the Escape transaction with no network access");

    const txid = await rpc.broadcast(ready.stdout);
    await regtest.mine(1);
    const received = (await rpc.getUtxos(destination)).find((u) => u.txid === txid);
    if (!received) throw new Error(`Escape ${txid} did not reach the destination`);
    ctx.log(
      `Escape ${txid} confirmed: ${received.value_sats} sats back with the Owner. NEAR not used.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
