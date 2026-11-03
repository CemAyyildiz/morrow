/**
 * What the scripted attacker tries, round by round. Pure: the same seed, budget and live
 * categories always give the same plan.
 *
 * Each round follows one order:
 *   1. `pre`: refusals that need a live Vault and no op (each refused by the Policy, not by the
 *      Vault's state), the Recovery Address redirect the watcher must veto, then the two
 *      Owner-Key-only Bitcoin spends (while the Vault coin is still unspent and confirmed, so the
 *      node's rejection is the script's and BIP68's, not a mempool conflict with the Clawback);
 *   2. `request`: one Withdrawal Request of the full balance, which the watcher claws back;
 *   3. `window`: the attempts that race the Clawback, sent at once: signed with consecutive
 *      nonces from one `view_access_key` read and sent concurrently;
 *   4. `fill`: after the Clawback, the rest of the round's budget, drawn by the seeded RNG.
 */

/** An attempt category, named after what it tries. Each one names its contract method. */
export type Category =
  | "withdrawal_request"
  | "early_execute"
  | "co_sign"
  | "clawback"
  | "storage"
  | "refresh"
  | "spend_allowance"
  | "policy_change"
  | "bitcoin_escape"
  | "bitcoin_no_cosigner";

export interface CategoryInfo {
  /** The Vault Contract method; null for a Bitcoin broadcast (no contract involved). */
  method: string | null;
  /** Plain words for the report. */
  label: string;
  /** The story that deploys the method, when it is not deployed yet. */
  story?: string;
}

/** In report order: the not-deployed one comes out as spend_allowance. */
export const CATEGORIES: Record<Category, CategoryInfo> = {
  withdrawal_request: { method: "request_withdrawal", label: "Withdrawal Request" },
  early_execute: { method: "begin_execute", label: "Execute before the Delay" },
  co_sign: { method: "sign_input", label: "Co-signature before the freeze" },
  clawback: { method: "begin_clawback", label: "Clawback as the Owner" },
  storage: { method: "top_up_storage", label: "Storage top-up with no deposit" },
  refresh: { method: "refresh", label: "Refresh", story: "4.1" },
  spend_allowance: { method: "spend_allowance", label: "Allowance spend", story: "5.2" },
  policy_change: { method: "propose_policy_change", label: "Policy Change", story: "5.1" },
  bitcoin_escape: {
    method: null,
    label: "Escape spend before the Escape Timelock, Owner Key only",
  },
  bitcoin_no_cosigner: {
    method: null,
    label: "Withdrawal-path spend without the Co-signer, Owner Key only",
  },
};

export const CATEGORY_ORDER = Object.keys(CATEGORIES) as Category[];

/** The five Attempt Log actions (Withdrawal Request, Allowance spend, Refresh, Policy Change, early Execute). */
export const ACTION_CATEGORIES: readonly Category[] = [
  "withdrawal_request",
  "spend_allowance",
  "refresh",
  "policy_change",
  "early_execute",
];

/**
 * Contract methods deployed on the live Vault Contract. Each Epic 4/5 story adds its own method
 * here when it ships; until then calling it would only prove the method is missing.
 */
export const LIVE_METHODS: readonly string[] = [
  "request_withdrawal",
  "begin_execute",
  "sign_input",
  "begin_clawback",
  "top_up_storage",
  "refresh",
  "propose_policy_change",
];

/** Categories the live mix may send: Bitcoin spends always, contract calls when deployed. */
export function liveCategories(methods: readonly string[] = LIVE_METHODS): Set<Category> {
  return new Set(
    CATEGORY_ORDER.filter((c) => {
      const method = CATEGORIES[c].method;
      return method === null || methods.includes(method);
    }),
  );
}

/** Every category: the dry run's mock contract has all five Attempt Log actions. */
export function allCategories(): Set<Category> {
  return new Set(CATEGORY_ORDER);
}

/** Categories in report order that `live` leaves out. */
export function notDeployed(live: ReadonlySet<Category>): Category[] {
  return CATEGORY_ORDER.filter((c) => !live.has(c));
}

/** The not-deployed categories in plain words, or null when every category was sent. */
export function notDeployedNote(live: ReadonlySet<Category>): string | null {
  const missing = notDeployed(live);
  if (missing.length === 0) return null;
  const names = missing.map((c) => {
    const info = CATEGORIES[c];
    return `${info.label} (${info.method}${info.story ? `, Story ${info.story}` : ""})`;
  });
  return (
    `Not attempted: ${names.join(", ")}. These methods are not deployed on this Vault Contract ` +
    "yet, and calling a missing method proves nothing about the Policy."
  );
}

export type Phase = "pre" | "request" | "window" | "fill";

/** What a planned attempt does; the run turns a move into one call or one broadcast. */
export type Move =
  | "clawback_as_owner"
  | "bad_envelope"
  | "allowance_over_limit"
  | "refresh_over_fee_cap"
  | "policy_change_script_bound"
  | "policy_change_redirect_recovery"
  | "escape_early"
  | "no_cosigner"
  | "full_request"
  | "execute_early"
  | "sign_before_freeze"
  | "same_coins_request"
  | "request_after_clawback"
  | "execute_after_clawback"
  | "sign_after_clawback"
  | "refresh_after_clawback"
  | "allowance_after_clawback"
  | "policy_change_after_clawback"
  | "storage_no_deposit";

/**
 * An expected outcome: `accepted` (the contract took it), `harmless` (it took it and nothing can
 * move), `rejected` (the Bitcoin node refused the broadcast), or an `ERR_*` code.
 */
export type Expected = string;

export interface MoveInfo {
  category: Category;
  phase: Phase;
  expected: readonly Expected[];
}

const AFTER_CLAWBACK = ["ERR_CLAWED_BACK", "ERR_VAULT_NOT_ACTIVE"] as const;

export const MOVES: Record<Move, MoveInfo> = {
  clawback_as_owner: { category: "clawback", phase: "pre", expected: ["ERR_UNAUTHORIZED"] },
  bad_envelope: { category: "withdrawal_request", phase: "pre", expected: ["ERR_BAD_ENVELOPE"] },
  // The Allowance is not deployed live yet: in the dry run the mock contract gives its code.
  allowance_over_limit: {
    category: "spend_allowance",
    phase: "pre",
    expected: ["ERR_ALLOWANCE_LIMIT"],
  },
  // Refused by the Fee Cap on the live contract (Story 4.1) and in the dry run's mock alike.
  refresh_over_fee_cap: { category: "refresh", phase: "pre", expected: ["ERR_FEE_TOO_HIGH"] },
  // ERR_CHANGE_PENDING: another visitor's change is pending (the contract checks that first).
  policy_change_script_bound: {
    category: "policy_change",
    phase: "pre",
    expected: ["ERR_SCRIPT_BOUND", "ERR_CHANGE_PENDING"],
  },
  // TH-12: a thief with the Owner Account rewrites the Recovery Address and waits. The contract
  // takes the proposal; the run then waits for the watcher's veto (still pending or applied at
  // the wait's end fails the run). Another visitor's pending change, or short storage under
  // spam, are refusals, never a risk.
  policy_change_redirect_recovery: {
    category: "policy_change",
    phase: "pre",
    expected: ["accepted", "ERR_CHANGE_PENDING", "ERR_STORAGE_BUDGET"],
  },
  escape_early: { category: "bitcoin_escape", phase: "pre", expected: ["rejected"] },
  no_cosigner: { category: "bitcoin_no_cosigner", phase: "pre", expected: ["rejected"] },
  // Another visitor's live request may hold the coin, or the storage may be short under spam:
  // both are refusals, never a risk.
  full_request: {
    category: "withdrawal_request",
    phase: "request",
    expected: ["accepted", "ERR_OUTPOINT_RESERVED", "ERR_CLAWED_BACK", "ERR_STORAGE_BUDGET"],
  },
  execute_early: {
    category: "early_execute",
    phase: "window",
    expected: ["ERR_NOT_EXECUTABLE", "ERR_CLAWED_BACK"],
  },
  sign_before_freeze: {
    category: "co_sign",
    phase: "window",
    expected: ["ERR_BAD_OP_STATE", "ERR_CLAWED_BACK"],
  },
  same_coins_request: {
    category: "withdrawal_request",
    phase: "window",
    expected: ["ERR_OUTPOINT_RESERVED", "ERR_CLAWED_BACK"],
  },
  request_after_clawback: {
    category: "withdrawal_request",
    phase: "fill",
    expected: AFTER_CLAWBACK,
  },
  execute_after_clawback: { category: "early_execute", phase: "fill", expected: AFTER_CLAWBACK },
  sign_after_clawback: { category: "co_sign", phase: "fill", expected: AFTER_CLAWBACK },
  refresh_after_clawback: { category: "refresh", phase: "fill", expected: AFTER_CLAWBACK },
  allowance_after_clawback: {
    category: "spend_allowance",
    phase: "fill",
    expected: AFTER_CLAWBACK,
  },
  policy_change_after_clawback: {
    category: "policy_change",
    phase: "fill",
    expected: AFTER_CLAWBACK,
  },
  storage_no_deposit: { category: "storage", phase: "fill", expected: ["harmless"] },
};

/** The scripted part of a round, in the frozen order. */
const SCRIPT: readonly Move[] = [
  "clawback_as_owner",
  "bad_envelope",
  "allowance_over_limit",
  "refresh_over_fee_cap",
  "policy_change_script_bound",
  "policy_change_redirect_recovery",
  "escape_early",
  "no_cosigner",
  "full_request",
  "execute_early",
  "sign_before_freeze",
  "same_coins_request",
];

/** The fill draw: refusals weigh 3, the harmless top-up 1. */
const FILL: readonly { move: Move; weight: number }[] = [
  { move: "request_after_clawback", weight: 3 },
  { move: "execute_after_clawback", weight: 3 },
  { move: "sign_after_clawback", weight: 3 },
  { move: "refresh_after_clawback", weight: 3 },
  { move: "allowance_after_clawback", weight: 3 },
  { move: "policy_change_after_clawback", weight: 3 },
  { move: "storage_no_deposit", weight: 1 },
];

export interface PlannedAttempt {
  move: Move;
  category: Category;
  phase: Phase;
  expected: readonly Expected[];
}

export interface PlannedRound {
  /** 1-based index within this run (not the challenge's round number). */
  index: number;
  /** Attempts this round may spend. */
  budget: number;
  /** The scripted attempts (pre, request, window), already cut to the budget. */
  scripted: PlannedAttempt[];
  /**
   * Fill attempts in draw order. There are `budget` of them, so a skipped scripted attempt (no
   * op to target, no coin) can hand its slot to the fill; the run never spends past `budget`.
   */
  fill: PlannedAttempt[];
}

export interface PlanOptions {
  seed: number;
  /** Attempts across all rounds. */
  n: number;
  rounds: number;
  categories: ReadonlySet<Category>;
}

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const planned = (move: Move): PlannedAttempt => ({ move, ...MOVES[move] });

/** Splits `n` over `rounds`: the first rounds take the remainder. Empty rounds are dropped. */
export function roundBudgets(n: number, rounds: number): number[] {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("n must be a whole number ≥ 1");
  if (!Number.isSafeInteger(rounds) || rounds < 1) {
    throw new RangeError("rounds must be a whole number ≥ 1");
  }
  const base = Math.floor(n / rounds);
  const extra = n % rounds;
  return Array.from({ length: rounds }, (_, i) => base + (i < extra ? 1 : 0)).filter((b) => b > 0);
}

export function buildPlan({ seed, n, rounds, categories }: PlanOptions): PlannedRound[] {
  const random = seededRandom(seed);
  const script = SCRIPT.filter((m) => categories.has(MOVES[m].category));
  const fill = FILL.filter((f) => categories.has(MOVES[f.move].category));
  const total = fill.reduce((sum, f) => sum + f.weight, 0);
  const draw = (): Move => {
    let pick = random() * total;
    for (const f of fill) {
      pick -= f.weight;
      if (pick < 0) return f.move;
    }
    return (fill[fill.length - 1] as { move: Move }).move;
  };
  return roundBudgets(n, rounds).map((budget, i) => ({
    index: i + 1,
    budget,
    scripted: script.slice(0, budget).map(planned),
    fill: fill.length === 0 ? [] : Array.from({ length: budget }, () => planned(draw())),
  }));
}
