import { recomputeAddress } from "@morrow/core-ts";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

/** S-1 Create: a real Vault on NEAR testnet whose addresses anyone can recompute. */
export async function runCreate(ctx: ScenarioContext): Promise<void> {
  const session = await judgeSession();
  const { config, client } = session;
  ctx.log(`Owner account ${session.accountId} created through the testnet faucet`);

  const { vaultId, tx } = await createJudgeVault(session);
  ctx.log(`Vault ${vaultId} created on ${config.vaultContract}: ${config.explorerTxUrl(tx)}`);

  const vault = await client.getVault(vaultId);
  if (vault.state !== "active")
    throw new Error(`Vault ${vaultId} is ${vault.state}, expected active`);
  ctx.log("Co-signer keys derived by the NEAR MPC network (v1.signer-prod.testnet)");

  const kit = await client.getVaultKit(vaultId);
  for (const role of ["vault", "allowance"] as const) {
    const script = role === "vault" ? kit.vault_script_hex : kit.allowance_script_hex;
    const recomputed = recomputeAddress(script, kit.btc_network);
    if (recomputed !== kit.addresses[role]) {
      throw new Error(
        `${role} address mismatch: contract ${kit.addresses[role]}, recomputed ${recomputed}`,
      );
    }
    ctx.log(
      `${role === "vault" ? "Vault" : "Allowance"} Address ${recomputed} recomputed independently: match`,
    );
  }
}
