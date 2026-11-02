import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  BitcoindRpc,
  MIN_VAULT_STORAGE_YOCTO,
  NearContractClient,
  RegtestControl,
  bytesToHex,
  createTestnetAccount,
  generateEnvelopeKeypair,
  presetPolicy,
  recomputeAddress,
} from "@morrow/core-ts";
import { KeyPair } from "near-api-js";
import type { JudgeConfig } from "../config.js";
import type { ScenarioContext } from "../scenarios.js";

/** A fresh, unique testnet account id for this run. */
export function judgeAccountId(now = Date.now(), random = Math.random()): string {
  return `morrow-judge-${now.toString(36)}-${random.toString(36).slice(2, 8)}.testnet`;
}

const newBitcoinKey = () =>
  bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));

/** S-1 Create: a real Vault on NEAR testnet whose addresses anyone can recompute. */
export async function runCreate(config: JudgeConfig, ctx: ScenarioContext): Promise<void> {
  const regtest = new RegtestControl(new BitcoindRpc(config.regtestRpcUrl));
  const recoveryAddress = await regtest.newAddress();

  const nearKey = KeyPair.fromRandom("ed25519");
  const accountId = judgeAccountId();
  await createTestnetAccount(accountId, nearKey.getPublicKey().toString());
  ctx.log(`Owner account ${accountId} created through the testnet faucet`);

  const client = new NearContractClient({
    contractId: config.vaultContract,
    rpcUrl: config.nearRpcUrl,
    signer: { accountId, secretKey: nearKey.toString() },
  });
  const watcher = await generateEnvelopeKeypair();
  const policy = presetPolicy("standard", {
    plannedDepositSats: 10_000_000n,
    guardians: [
      {
        guardian_key: newBitcoinKey(),
        guardian_account: "morrow-judge-guardian.testnet",
        kind: "backup_device",
      },
    ],
    recoveryAddress,
    network: "regtest",
    watcherX25519Pk: watcher.publicKeyHex,
  });

  const vaultId = await client.createVault({
    owner_key: newBitcoinKey(),
    policy,
    deposit_yocto: MIN_VAULT_STORAGE_YOCTO.toString(),
  });
  const createTx = client.lastTransactionHash ?? "";
  ctx.log(`Vault ${vaultId} created on ${config.vaultContract}: ${config.explorerTxUrl(createTx)}`);

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
