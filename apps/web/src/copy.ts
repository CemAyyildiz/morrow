// Shell copy. Rules (checked by copy.test.ts): no emoji, no exclamation marks, no hype
// words, no relative times. Times arrive as absolute values from data.
import type { BtcNetwork, NearNetwork, NetworkPair } from "@/app/data";

const BTC_COINS: Record<Exclude<BtcNetwork, "bitcoin">, string> = {
  testnet: "Testnet",
  signet: "Signet",
  regtest: "Regtest",
};

const NEAR_SIDE: Record<NearNetwork, string> = {
  mainnet: "NEAR mainnet",
  testnet: "NEAR testnet",
  mock: "mock contract",
};

/** `1 attempt`, `2 attempts`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const copy = {
  wordmark: "morrow",
  skipToContent: "Skip to content",

  nav: {
    label: "Main",
    vault: "Vault",
    challenge: "Challenge",
    guardians: "Guardians",
    policy: "Policy",
    proof: "Proof",
    xray: "X-Ray",
    live: "live",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    menu: "Menu",
  },

  titles: {
    vault: "Vault",
    challenge: "Challenge vault",
    guardians: "Guardians",
    policy: "Policy",
    proof: "Proof",
    xray: "X-Ray",
    notFound: "Not found",
  },

  system: {
    contract: "contract",
    coSigner: "co-signer",
    contractState: { locked: "locked", unlocked: "unlocked" },
  },

  challenge: {
    round: (round: number) => `round ${round}`,
    keysPublished: "keys published",
    downloadKeys: "Download keys",
    tryKeys: "Try with these keys",
    nextWithdrawal: "Next possible withdrawal",
    requested: (at: string) => `Requested ${at}`,
    left: (remaining: string) => `${remaining} left`,
    delayElapsed: "Share of the delay that has passed",
    explainer: (time: string) =>
      `Anyone can use this vault's owner keys. The NEAR contract holding the other half won't sign before ${time}, and the guardian sends every attempt home.`,
    attemptsLabel: "Attempts with the published keys",
    /** The words after the attempts numeral: `attempts · 0 sats out`. */
    attemptsUnit: (count: number, satsOut: number) =>
      `${count === 1 ? "attempt" : "attempts"} · ${plural(satsOut, "sat")} out`,
    attemptsWindow: (round: number) => `Round ${round} · last 24 h`,
    lastAttempt: (at: string) => `Last attempt ${at}`,
    hourlySummary: (total: number, activeHours: number, peak: number) =>
      `${plural(total, "attempt")} in ${activeHours} of 24 hours, at most ${peak} in one hour`,
    heldInVault: "Held in vault",
    delay: "Delay",
    perWithdrawal: "per withdrawal",
    satsTaken: "Sats taken",
    coSigner: "Co-signer",
  },

  placeholder: "This screen is not part of this build.",

  notFound: {
    body: (path: string) => `Nothing lives at ${path}.`,
    link: "Open Challenge",
  },

  /** The banner line, or null only when both sides are mainnet. */
  networkBanner: ({ btc, near }: NetworkPair): string | null => {
    if (btc === "bitcoin") {
      return near === "mainnet" ? null : `Real bitcoin · ${NEAR_SIDE[near]} · test deployment`;
    }
    return `${BTC_COINS[btc]} test coins · ${NEAR_SIDE[near]} · not real bitcoin`;
  },

  /** The network line of the sidebar system card, e.g. `signet · NEAR testnet`. */
  systemNetwork: ({ btc, near }: NetworkPair) => `${btc} · ${NEAR_SIDE[near]}`,
} as const;
