import type { NetworkPair } from "@/app/data";
import { copy } from "@/copy";

// A full-width strip above the shell on every screen that is not Bitcoin mainnet.
// Neutral on purpose: never orange, never alarm.
export function TestnetBanner({ network }: { network: NetworkPair }) {
  const line = copy.networkBanner(network);
  if (line === null) return null;
  return (
    <div
      role="note"
      data-testid="testnet-banner"
      className="w-full border-b border-line bg-card-raised px-gutter-mobile py-2 text-center font-mono text-mono text-muted"
    >
      {line}
    </div>
  );
}
