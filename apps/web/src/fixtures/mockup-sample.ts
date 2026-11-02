// Sample data from the approved mockup. Remove before any public deploy.
//
// Only src/app/SampleDataProvider.tsx imports this module. Deleting it touches only
// src/fixtures/ and that provider.
import type { AppConfig, ChallengeData } from "@/app/data";

export const sampleConfig: AppConfig = {
  network: { btc: "signet", near: "testnet" },
  contract: "locked",
  coSigner: "v1.signer",
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
};
