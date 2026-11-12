import type { AppConfig } from "@/app/data";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { copy } from "@/copy";

const t = copy.vault;

export type WalletPageProblemKind = "network" | "nonce";

/**
 * Why a wallet page cannot run here: it needs NEAR testnet with a NEAR RPC and Bitcoin signet
 * (no mainnet, no regtest), and the nonce the server writes into wallet pages.
 */
export function walletPageProblem(
  config: Pick<AppConfig, "network" | "nearRpcUrl">,
  nonce: string | null,
): WalletPageProblemKind | null {
  if (config.network.near !== "testnet" || config.network.btc !== "signet") return "network";
  if (config.nearRpcUrl === null) return "network";
  if (nonce === null) return "nonce";
  return null;
}

export function WalletPageProblem({ problem }: { problem: WalletPageProblemKind }) {
  return (
    <Card
      data-testid="wallet-page-problem"
      data-problem={problem}
      className="flex flex-col items-start gap-3 p-card-pad-mobile desktop:p-card-pad"
    >
      <CardTitle>{problem === "network" ? t.unsupported : t.noNonce}</CardTitle>
      {problem === "network" ? (
        <CardDescription className="max-w-[640px]">{t.unsupportedBody}</CardDescription>
      ) : (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          {t.reload}
        </Button>
      )}
    </Card>
  );
}
