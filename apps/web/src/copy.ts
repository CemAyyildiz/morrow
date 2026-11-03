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
    contractState: {
      locked: "locked",
      unlocked: "unlocked",
      checking: "checking",
      unknown: "unknown",
    },
    /**
     * The heartbeat's age, wording fixed by story 1.9b. A duration since the watcher's last
     * report, not a time of day, so copy.test.ts exempts it from the relative-time rule.
     */
    alertsSeen: (minutes: number) => `Alerts: watcher last seen ${minutes} min ago`,
    alertsNone: "Alerts: no watcher configured",
    alertsChecking: "Alerts: checking watcher",
    alertsUnreachable: "Alerts: watcher unreachable",
    alertsSilent: "Alerts: watcher has not reported",
  },

  config: {
    loading: "Loading the deployment configuration",
    failedTitle: "Configuration unavailable",
    failedBody:
      "This deployment did not serve a valid /config.json, so the app cannot tell which networks or contract it belongs to.",
  },

  challenge: {
    noRound: "No round is open yet",
    noRoundBody:
      "When a round opens, its vault, the published owner keys and every attempt to use them appear here.",
    unreachable: "The Challenge feed is not answering",
    unreachableBody: "The page asks again every 30 seconds. Retrying.",
    round: (round: number) => `round ${round}`,
    keysPublished: "keys published",
    downloadKeys: "Download keys",
    tryKeys: "Try with these keys",
    nextWithdrawal: "Next possible withdrawal",
    requested: (at: string) => `Requested ${at}`,
    /** The earliest withdrawal time with its date, when it is not today. */
    timeOnDay: (time: string, day: string) => `${time} on ${day}`,
    noRequest: "No withdrawal request is pending",
    left: (remaining: string) => `${remaining} left`,
    /** The right end of the delay bar while no request is pending: the whole Delay. */
    fullDelay: (delay: string) => `${delay} delay`,
    delayElapsed: "Share of the delay that has passed",
    explainer: (time: string) =>
      `Anyone can use this vault's owner keys. The NEAR contract holding the other half won't sign before ${time}, and the guardian sends every attempt home.`,
    attemptsLabel: "Attempts with the published keys",
    /** The words after the attempts numeral: `attempts · 0 sats out`. */
    attemptsUnit: (count: number, satsOut: number) =>
      `${count === 1 ? "attempt" : "attempts"} · ${plural(satsOut, "sat")} out`,
    attemptsWindow: (round: number) => `Round ${round} · last 24 h`,
    lastAttempt: (at: string) => `Last attempt ${at}`,
    noAttemptYet: "No attempt yet",
    hourlySummary: (total: number, activeHours: number, peak: number) =>
      `${plural(total, "attempt")} in ${activeHours} of 24 hours, at most ${peak} in one hour`,
    heldInVault: "Held in vault",
    delay: "Delay",
    perWithdrawal: "per withdrawal",
    satsTaken: "Sats taken",
    coSigner: "Co-signer",
    factsLabel: "About this round",
    /** The coins note for the round's Bitcoin network. */
    coins: (btc: BtcNetwork) =>
      btc === "bitcoin" ? "Real bitcoin" : `${BTC_COINS[btc]} test coins · not real bitcoin`,
    /** The rotation deadline; `at` is an estimate from the tip at 10 minutes per block. */
    rotation: (height: number, at: string | null) =>
      `New vault by block ${height.toLocaleString("en-US")}${at === null ? "" : ` · about ${at}`}`,
    bounty: "Mainnet Bounty",
    /** The `how_to` text of the downloaded keys file. */
    howTo:
      "These are the published keys of a Morrow Challenge Vault. owner_key and owner_key_secret are the Owner Key that signs the Bitcoin side. near_function_call_key signs Vault Contract calls on vault_contract as owner_account. Request a withdrawal from vault_id and try to move the coins at vault_address. The Vault Contract will not co-sign before the Delay ends, and the guardian claws every request back to the operator's Recovery Address. Every attempt appears in the Attempt Log.",
  },

  attemptLog: {
    title: "Attempt log",
    empty: "No attempts this round yet. The keys are above.",
    withdrawal: "Withdrawal Request",
    policyChange: "Policy Change",
    earlyExecute: "Early Execute",
    unknownCall: "Contract call",
    /** Marks a row from an earlier round than the one shown. */
    roundTag: (round: number) => `round ${round}`,
    outcome: {
      clawedBack: (seconds: number) => `Clawed back in ${seconds} s`,
      vetoed: "Vetoed",
      rejected: (code: string) => `Rejected ${code}`,
      pending: "Pending",
      cancelled: "Cancelled",
      signed: "Signed",
      withdrawn: "Withdrawn",
      applied: "Applied",
    },
    nearLink: "NEAR",
    bitcoinLink: "Bitcoin",
    nearTxLabel: (n: number) => `NEAR transaction of attempt ${n}`,
    nearAccountLabel: (n: number) => `Owner Account of attempt ${n} on NEAR`,
    bitcoinTxLabel: (n: number) => `Bitcoin transaction of attempt ${n}`,
    /** Read out once when a new row arrives. */
    announce: (n: number, action: string, outcome: string) => `Attempt ${n}: ${action}, ${outcome}`,
  },

  xray: {
    title: "X-Ray · latest attempt",
    notReached: "not reached",
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
