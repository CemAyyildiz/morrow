import { NEAR_RPC_URLS } from "@morrow/core-ts";

export interface JudgeConfig {
  vaultContract: string;
  nearRpcUrl: string;
  regtestRpcUrl: string;
  explorerTxUrl: (hash: string) => string;
  /** Optional funded account that creates the judge accounts instead of the public faucet. */
  funder: { accountId: string; secretKey: string } | null;
}

/** The current public demo deployment on NEAR testnet. */
export const DEFAULT_VAULT_CONTRACT = "morrow-vault-v1.testnet";

export function loadJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  return {
    vaultContract: env.MORROW_VAULT_CONTRACT ?? DEFAULT_VAULT_CONTRACT,
    nearRpcUrl: env.MORROW_NEAR_RPC_URL ?? NEAR_RPC_URLS.testnet,
    regtestRpcUrl: env.MORROW_REGTEST_RPC ?? "http://morrow:morrow@127.0.0.1:18443",
    explorerTxUrl: (hash) => `https://testnet.nearblocks.io/txns/${hash}`,
    funder:
      env.MORROW_JUDGE_FUNDER_ACCOUNT && env.MORROW_JUDGE_FUNDER_KEY
        ? { accountId: env.MORROW_JUDGE_FUNDER_ACCOUNT, secretKey: env.MORROW_JUDGE_FUNDER_KEY }
        : null,
  };
}
