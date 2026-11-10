import { MorrowContractError, completeAndBroadcast, sealEnvelope } from "@morrow/core-ts";
import { afterWrite, allSigned } from "../chain.js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** S-2 Withdraw after Delay: early Execute fails; after the Delay, MPC co-signs and Bitcoin confirms. */
export async function runWithdraw(ctx: ScenarioContext): Promise<void> {
  const session = await judgeSession();
  const { client, config, regtest, rpc } = session;
  const { vaultId } = await createJudgeVault(session);
  const kit = await afterWrite("get_vault_kit", () => client.getVaultKit(vaultId));

  await regtest.fund(kit.addresses.vault, 1_000_000n);
  await regtest.fund(kit.addresses.vault, 1_000_000n);
  await regtest.mine(1);
  const utxos = (await rpc.getUtxos(kit.addresses.vault)).map(({ txid, vout, value_sats }) => ({
    txid,
    vout,
    value_sats,
  }));
  ctx.log(`Vault ${vaultId} funded on regtest with ${utxos.length} coins (0.02 BTC)`);

  const destination = await regtest.newAddress();
  const envelope = await sealEnvelope("normal", session.watcher.publicKeyHex);
  const opId = await client.requestWithdrawal({
    vault_id: vaultId,
    amount_sats: "1500000",
    destination,
    fee_rate_sat_vb: 2,
    utxos,
    envelope,
  });
  const op = await afterWrite("get_op", () => client.getOp(opId));
  ctx.log(
    `Withdrawal ${opId} requested: ${config.explorerTxUrl(client.lastTransactionHash ?? "")}`,
  );

  try {
    await client.beginExecute(opId, envelope);
    throw new Error("Execute before the Delay succeeded");
  } catch (error) {
    if (!(error instanceof MorrowContractError && error.code === "ERR_NOT_EXECUTABLE")) throw error;
    ctx.log("Execute before the Delay rejected: ERR_NOT_EXECUTABLE");
  }

  const executableAtMs = Number(BigInt(op.executable_at ?? "0") / 1_000_000n);
  ctx.log(`Waiting for the Delay (executable at ${new Date(executableAtMs).toISOString()})`);
  await sleep(Math.max(0, executableAtMs - Date.now()) + 2_000);
  let frozen;
  for (let attempt = 0; ; attempt++) {
    try {
      frozen = await client.beginExecute(opId, envelope);
      break;
    } catch (error) {
      const early = error instanceof MorrowContractError && error.code === "ERR_NOT_EXECUTABLE";
      if (!early || attempt >= 60) throw error;
      await sleep(3_000);
    }
  }
  ctx.log(`Contract built the transaction and froze ${frozen.sighashes.length} sighashes`);

  for (let i = 0; i < frozen.sighashes.length; i++) {
    const started = Date.now();
    await client.signInput(opId, i);
    ctx.log(
      `Input ${i} co-signed by the NEAR MPC network in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  const signed = await afterWrite("get_op", () => client.getOp(opId), allSigned);
  if (signed.state !== "signed") throw new Error(`Op ${opId} is ${signed.state}, expected signed`);

  const txid = await completeAndBroadcast(signed, kit.vault_script_hex, session.ownerSecret, rpc);
  await regtest.mine(1);
  const status = await rpc.getTx(txid);
  const received = (await rpc.getUtxos(destination)).find((u) => u.txid === txid);
  if (!status || status.confirmations < 1) throw new Error(`Withdrawal ${txid} did not confirm`);
  if (received?.value_sats !== "1500000")
    throw new Error(`Destination received ${received?.value_sats ?? 0} sats`);
  ctx.log(`Bitcoin transaction ${txid} confirmed; destination received 1,500,000 sats`);
}
