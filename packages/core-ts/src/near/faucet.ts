export const TESTNET_FAUCET_URL = "https://helper.testnet.near.org/account";

export interface FaucetOptions {
  url?: string;
  attempts?: number;
  fetchFn?: typeof fetch;
  /** Delay before retry n (1-based), in milliseconds. */
  backoffMs?: (attempt: number) => number;
}

/** Creates a funded NEAR testnet account through the public faucet helper. */
export async function createTestnetAccount(
  accountId: string,
  publicKey: string,
  {
    url = TESTNET_FAUCET_URL,
    attempts = 3,
    fetchFn = fetch,
    backoffMs = (n) => 2_000 * n,
  }: FaucetOptions = {},
): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    }).catch((error: unknown) => error as Error);
    if (!(response instanceof Error) && response.ok) return;
    lastError = response instanceof Error ? response.message : `HTTP ${response.status}`;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
  }
  throw new Error(`Testnet faucet failed for ${accountId}: ${lastError}`);
}
