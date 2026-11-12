import { MorrowContractError, completeAndBroadcast, sealEnvelope } from "@morrow/core-ts";
import { afterWrite, allSigned } from "../chain.js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

/**
 * S-3 Thief and Clawback: the judge holds the real Owner keys and tries to rob the Vault. A
 * Guardian claws back; the coins go home and the attacker receives nothing.
 */
export async function runThief(ctx: ScenarioContext): Promise<void> {
  const session = await judgeSession();
  const { client, guardianClient, config, regtest, rpc } = session;
  const { vaultId } = await createJudgeVault(session);
  const kit = await afterWrite("get_vault_kit", () => client.getVaultKit(vaultId));
  const vault = await afterWrite("get_vault", () => client.getVault(vaultId));
  await regtest.fund(kit.addresses.vault, 1_000_000n);
  await regtest.mine(1);
  const utxos = (await rpc.getUtxos(kit.addresses.vault)).map(({ txid, vout, value_sats }) => ({
    txid,
    vout,
    value_sats,
  }));
  ctx.log(`Vault ${vaultId} holds 0.01 BTC on regtest`);

  ctx.log("You hold the Owner keys. Trying to rob the vault…");
  const attacker = await regtest.newAddress();
  const envelope = await sealEnvelope("normal", session.watcher.publicKeyHex);
  const theft = await client.requestWithdrawal({
    vault_id: vaultId,
    amount_sats: "900000",
    destination: attacker,
    fee_rate_sat_vb: 2,
    utxos,
    envelope,
  });
  ctx.log(
    `Thief's withdrawal ${theft} is public and waits the Delay: ${config.explorerTxUrl(client.lastTransactionHash ?? "")}`,
  );
  // The real keys buy the thief nothing yet: the contract will not co-sign before the Delay.
  try {
    await client.beginExecute(theft, envelope);
    throw new Error("The thief's Execute succeeded before the Delay");
  } catch (error) {
    if (!(error instanceof MorrowContractError && error.code === "ERR_NOT_EXECUTABLE")) throw error;
    ctx.log("Thief tries to execute at once: ERR_NOT_EXECUTABLE");
  }

  const clawbackId = await guardianClient.beginClawback({
    vault_id: vaultId,
    utxos,
    fee_rate_sat_vb: 4,
  });
  ctx.log(
    `Guardian ${session.guardianAccountId} claws back: ${config.explorerTxUrl(guardianClient.lastTransactionHash ?? "")}`,
  );
  const frozen = await afterWrite("get_op", () => guardianClient.getOp(clawbackId));
  for (let i = 0; i < frozen.sighashes.length; i++) {
    const started = Date.now();
    await guardianClient.signInput(clawbackId, i);
    ctx.log(
      `Clawback input ${i} co-signed by the NEAR MPC network in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  const signed = await afterWrite("get_op", () => guardianClient.getOp(clawbackId), allSigned);
  const txid = await completeAndBroadcast(
    signed,
    kit.vault_script_hex,
    { role: "guardian", secretKey: session.guardianSecret },
    rpc,
  );
  await regtest.mine(1);
  const home = (await rpc.getUtxos(vault.policy.recovery_address)).find((u) => u.txid === txid);
  if (!home) throw new Error(`Clawback ${txid} did not reach the Recovery Address`);
  ctx.log(`Clawback ${txid} confirmed: ${home.value_sats} sats back at the Recovery Address`);

  try {
    await client.beginExecute(theft, envelope);
    throw new Error("The thief's Execute succeeded after a Clawback");
  } catch (error) {
    if (!(error instanceof MorrowContractError && error.code === "ERR_CLAWED_BACK")) throw error;
    ctx.log("Thief tries to execute: ERR_CLAWED_BACK");
  }
  const stolen = (await rpc.getUtxos(attacker)).reduce((sum, u) => sum + BigInt(u.value_sats), 0n);
  if (stolen !== 0n) throw new Error(`Attacker received ${stolen} sats`);
  ctx.log("Attacker received 0 sats");
}
