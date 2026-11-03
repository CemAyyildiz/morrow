// Sample data from the approved mockup, for the dev server only.
//
// Only src/app/SampleDataProvider.tsx imports this module, and main.tsx loads that provider
// only under `import.meta.env.DEV`. `vite build` fails if this module enters the bundle.
import type { AppConfig, ChallengeData } from "@/app/data";

export const sampleConfig: AppConfig = {
  network: { btc: "signet", near: "testnet" },
  contractId: "challenge.morrow.testnet",
  nearRpcUrl: null,
  btcBackendUrl: "http://localhost:3002",
  watcherUrl: null,
  challengeUrl: null,
  bountyUrl: null,
  contract: "locked",
  coSigner: "v1.signer-prod.testnet",
  heartbeat: { kind: "seen", minutes: 1, stale: false },
};

export const sampleChallenge: ChallengeData = {
  round: 7,
  keysPublished: true,
  withdrawal: {
    time: "06:12",
    day: "tomorrow",
    requestedAt: "yesterday, 06:12",
    remaining: "18 h 59 m",
    elapsed: 0.21,
  },
  attempts: {
    count: 13,
    total: 13,
    satsOut: 0,
    hourly: [0, 0, 1, 0, 0, 2, 1, 0, 0, 0, 1, 0, 0, 3, 1, 0, 0, 1, 0, 2, 0, 0, 1, 0],
    lastAt: "03:11",
  },
  vault: {
    amount: "0.01000000",
    unit: "sBTC",
    delay: "24 h",
  },
  satsTaken: 0,
  coSigner: { threshold: 11, total: 16 },
  rotation: { height: 291_744, at: "13 Nov 06:12" },
  coins: "Signet test coins · not real bitcoin",
  bountyUrl: null,
  keys: null,
  log: null,
  pending: null,
};
