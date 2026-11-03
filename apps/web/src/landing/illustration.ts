// ILLUSTRATION ONLY. The approved mockup's values for the product drawn inside the hero
// laptop, shown only while no live round exists (`useAppData().challenge` is null: no
// challenge feed configured, or no round open). They never appear outside the laptop
// screen, and a live round replaces them. Kept out of src/fixtures on purpose: the production build ships them, as
// the picture on the laptop screen.
import type { AttemptRow, ChallengeData } from "@/app/data";
import type { XRayStep } from "@/components/XRaySteps";

export const illustrationChallenge: ChallengeData = {
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
  vault: { amount: "0.01000000", unit: "sBTC", delay: "24 h" },
  satsTaken: 0,
  coSigner: { threshold: 11, total: 16 },
  rotation: { height: 291_744, at: "13 Nov 06:12" },
  coins: "Signet test coins · not real bitcoin",
  bountyUrl: null,
  keys: null,
  log: null,
  pending: null,
};

export const illustrationLog: readonly AttemptRow[] = [
  {
    n: 13,
    at: "03:11",
    action: "full withdrawal",
    outcome: { tone: "ok", text: "clawed back · 38 s" },
  },
  { n: 12, at: "02:47", action: "shorten delay to 1 min", outcome: { tone: "ok", text: "vetoed" } },
  {
    n: 11,
    at: "02:40",
    action: "execute before delay",
    outcome: { tone: "alarm", text: "ERR_NOT_EXECUTABLE" },
  },
  {
    n: 10,
    at: "01:58",
    action: "full withdrawal",
    outcome: { tone: "ok", text: "clawed back · 41 s" },
  },
  { n: 9, at: "01:20", action: "allowance × 3", outcome: { tone: "alarm", text: "cap reached" } },
];

/** The four X-Ray steps of a clawed-back attempt; the state is set per run. */
export const xrayScript: readonly Omit<XRayStep, "state">[] = [
  { title: "Request accepted", detail: "request_withdrawal · executes tomorrow" },
  { title: "Execute refused", detail: "now < executable_at → ERR_NOT_EXECUTABLE" },
  { title: "Sweep co-signed", detail: "NEAR MPC · 11 of 16 · morrow/v1/42/vault" },
  { title: "Sent home", detail: "5e1f…09c9 → tb1q…recovery · 0 sats out" },
];
