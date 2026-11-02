// Landing copy, from the approved mockup (mockups/landing/index.html). Rules (checked by
// copy.test.ts): no emoji, no exclamation marks, no hype words. Brand lines may say
// "tomorrow": it is the product's promise, not a vague time.
//
// No count here is presented as a live fact. The record line keeps a no-number fallback
// until story 9.4 wires the Attempt Log; the feature panels, the phone and the cards are
// product illustrations of one example vault (Daniel's, guarded by Emma).
import type { BtcNetwork, ContractState } from "@/app/data";

const COINS: Record<BtcNetwork, string> = {
  bitcoin: "Real bitcoin",
  testnet: "Testnet test coins",
  signet: "Signet test coins",
  regtest: "Regtest test coins",
};

export const landingCopy = {
  documentTitle: "morrow · Bitcoin that can't be rushed",
  wordmark: "morrow",
  githubUrl: "https://github.com/CemAyyildiz/morrow",

  nav: {
    label: "Site",
    howItWorks: "How it works",
    rob: "Rob this vault",
    proof: "Proof",
    github: "GitHub",
  },

  hero: {
    title: "Bitcoin that can't be rushed.",
    lede: "We published the keys to this vault. Nobody has taken a single sat, because a NEAR contract won't co-sign before tomorrow.",
    rob: "Rob this vault",
    readProof: "Read the proof",
    sceneAlt:
      "A pale oak desk and a cognac leather chair on an alpine meadow at sunrise, an open laptop on the desk, a sea of clouds and mountains behind",
    /** The legal line at the foot of the scene, from the live deployment config. */
    legal: (btc: BtcNetwork, contract: ContractState) =>
      `${COINS[btc]} · Bitcoin P2WSH · NEAR Chain Signatures · contract ${contract}`,
    productLabel: "The Challenge vault, product view",
    /** Read out with the product view while it shows the illustration, not a live round. */
    sampleNote: "sample values until a round opens",
  },

  features: {
    title: ["Everything a vault should do.", "Nothing a thief can rush."],
    items: [
      {
        title: "Every withdrawal waits",
        body: "Pick a delay from one hour to thirty days. Nothing leaves before it ends, not even with your own keys.",
      },
      {
        title: "A guardian can bring it home",
        body: "Your guardian is alerted within a minute. One tap sweeps everything to your cold wallet, and only there.",
      },
      {
        title: "A PIN that lies for you",
        body: "Under duress, a second PIN looks exactly the same. Behind it, the watcher schedules the clawback before anything can leave.",
      },
      {
        title: "Proof, not promise",
        body: "Every rule is a public NEAR contract, locked for good. Anyone can read the policy and recompute the address.",
      },
      {
        title: "Never hostage",
        body: "If NEAR ever disappears, Bitcoin alone lets you out after the escape timelock.",
      },
    ],
    delay: {
      label: "Vault #42 · delay",
      title: "0.10000000 BTC to tb1q…9f2a",
      requested: "Requested 14:02",
      left: "23 h 41 m left",
      today: "requested",
      todayAt: "14:02",
      executable: "executable",
      executableAt: "tomorrow 14:02",
      rows: [
        ["Guardians notified", "Emma · watcher"],
        ["Cancel", "any time before execution"],
        ["Co-signer", "refuses until 14:02 tomorrow"],
      ],
    },
    guardian: {
      label: "Guardian · Emma's phone · 03:10",
      title: "One tap, and it goes home.",
      source: "MORROW · GUARDIAN",
      when: "now",
      alert: "Daniel's vault: full withdrawal requested",
      rows: [
        ["Amount", "0.75000000 BTC"],
        ["To", "tb1q…x7tk · never paid"],
        ["Executable", "tomorrow 03:10"],
      ],
      sendHome: "Send it home",
      itWasDaniel: "It was Daniel",
    },
    duress: {
      label: "Duress protection",
      title: "Two PINs. One screen. Nothing to tell them apart.",
      normal: "Normal PIN",
      duress: "Duress PIN",
      note: "same key · same methods · same 80-byte envelope on-chain",
    },
    proof: {
      label: "Proof page · vault #42",
      title: "Read the rules yourself.",
      rows: [
        ["Delay", "24 h"],
        ["Clawback goes only to", "tb1q…cold"],
        ["Escape", "owner alone after 26,280 blocks"],
        ["Contract", "locked · code 9f3a…c2"],
        ["Co-signer", "NEAR MPC · 11 of 16"],
      ],
      address: ["Address", "recomputed from script ✓"],
    },
    escape: {
      label: "Vault script · three paths",
      title: "The co-signer can never spend alone.",
      paths: [
        ["Withdraw", "you + NEAR contract", "after the delay"],
        ["Clawback", "guardian + NEAR contract", "to your cold wallet only"],
        ["Escape", "you alone", "after ~6 months, no NEAR"],
      ],
    },
  },

  collage: {
    top: [
      "******",
      "The thief has your keys. The contract doesn't care.",
      "Every withdrawal waits. Every theft goes home.",
    ],
    marquee: "NOT BEFORE TOMORROW · NOT BEFORE TOMORROW · NOT BEFORE TOMORROW ·",
    bottom: ["It's self-custody that holds up at 3 a.m.", "******"],
    tiles: {
      timelock: "An antique brass bank time-lock movement with three clock dials",
      emma: "A woman checking her phone in a dim kitchen at night",
      vaultdoor: "A round steel vault door standing ajar in a dark corridor",
      nightphone: "A phone glowing on a bedside table at night",
      drawer: "A hardware wallet in a wooden drawer beside a brass key",
      clouds: "Sunrise over a sea of clouds",
    },
    phone: {
      time: "03:10",
      date: "Friday, November 13",
      source: "MORROW",
      when: "now",
      title: "Daniel's vault: withdrawal requested",
      body: "0.75 BTC to an address never paid before. Executable tomorrow 03:10.",
      sendHome: "Send it home",
      itWasDaniel: "It was Daniel",
    },
  },

  record: {
    // No-number fallback until story 9.4 wires the live count from the Attempt Log.
    lead: "The real keys are published.",
    em: "Not one sat",
    tail: " leaves before the delay ends.",
    by: "The attempt log",
    byDetail: "Challenge vault · counted from on-chain events",
  },

  cards: {
    title: ["Built for the worst night,", "quiet on every other."],
    alerts: {
      source: "MORROW · GUARDIAN · now",
      title: "Withdrawal requested · 0.75 BTC",
      ghostSource: "MORROW · 03:08",
      ghostTitle: "Policy change proposed",
      action: "Send it home",
      heading: "Alerts in under a minute",
      body: "Every request and every rule change reaches your guardians on Telegram before it can matter.",
    },
    proof: {
      hash: "sha256(vault_script)",
      address: "→ tb1q3hzen…98shgvk6e",
      match: "✓ matches the vault address",
      ghost: "code_hash 9f3a…c2 · locked",
      heading: "Proof you can recompute",
      body: "The Proof Page reads the contract live and lets anyone rebuild the address from the script in their own browser.",
    },
    kit: {
      file: "morrow-vault-kit.json",
      size: "2 KB · keep it offline",
      escape: "escape after 26,280 blocks",
      ghost: "works without NEAR",
      heading: "A kit for the worst day",
      body: "One small file and your own key get your bitcoin out, even if every server, including ours, is gone.",
    },
    pin: {
      label: "PIN",
      heading: "A PIN that lies for you",
      body: "Under coercion, the duress PIN behaves exactly like the real one. Only your guardian's watcher knows the difference.",
    },
  },

  final: {
    title: "Tomorrow, it's still yours.",
    body: "Set a delay, name a guardian, keep the kit. Morrow takes care of the night.",
    rob: "Rob this vault",
    alt: "The desk on the alpine meadow in full morning sun",
  },

  footer: {
    left: "morrow · Bitcoin that can't be rushed.",
    right: (btc: BtcNetwork) => `NEAR Chain Signatures · Bitcoin P2WSH · ${COINS[btc]}`,
  },

  attempt: {
    /** The row a simulated attempt adds, and its announcement. */
    action: "full withdrawal",
    outcome: "clawed back · 36 s",
    announce: (n: number) => `Illustration: attempt #${n} clawed back · 0 sats out`,
  },
} as const;
