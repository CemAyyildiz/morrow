import { recomputeAddress } from "@morrow/core-ts";
import { JsonRpcProvider } from "near-api-js";
import type { ScenarioContext } from "../scenarios.js";
import { createJudgeVault, judgeSession } from "../session.js";

/** The MPC signer a Vault Contract deployment co-signs with, from its `get_config` view. */
export function signerAccountOf(config: unknown): string {
  const signer = (config as { signer_account?: unknown } | null)?.signer_account;
  if (typeof signer !== "string" || signer === "") {
    throw new Error("get_config has no signer_account");
  }
  return signer;
}

/** S-1 Create: a real Vault on NEAR testnet whose addresses anyone can recompute. */
export async function runCreate(ctx: ScenarioContext): Promise<void> {
  const session = await judgeSession();
  const { config, client } = session;
  ctx.log(
    `Owner account ${session.accountId} created${config.funder ? "" : " through the testnet faucet"}`,
  );

  const { vaultId, tx } = await createJudgeVault(session);
  ctx.log(`Vault ${vaultId} created on ${config.vaultContract}: ${config.explorerTxUrl(tx)}`);

  const vault = await client.getVault(vaultId);
  if (vault.state !== "active")
    throw new Error(`Vault ${vaultId} is ${vault.state}, expected active`);
  const signer = signerAccountOf(
    await new JsonRpcProvider({ url: config.nearRpcUrl }).callFunction({
      contractId: config.vaultContract,
      method: "get_config",
      args: {},
    }),
  );
  ctx.log(`Co-signer keys derived by the NEAR MPC network (${signer})`);

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
