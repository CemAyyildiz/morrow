/**
 * The attack report: a JSON document a judge can re-check against the chain. The writer refuses
 * to put a mock or regtest report under the repository's `evidence/` (that path is for
 * real-chain runs only; regtest is allowed only under `evidence/regtest/` and labelled).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PolicyChangeOutcome } from "../attempts.js";
import type { Category } from "./plan.js";

/**
 * What the veto wait saw for a round's redirect: the change's outcome, `unread` (no longer
 * pending, but the feed never showed how it settled) or `unreadable` (the Vault, or the change
 * id of an accepted redirect, could not be read).
 */
export type RedirectOutcome = PolicyChangeOutcome | "unread" | "unreadable";

/** The network a report was produced against. `mock` is the dry run. */
export type ReportNetwork = "mock" | "regtest" | "signet" | "testnet4" | "bitcoin";

/** `unknown`: no round was ever attacked, so no network was seen. Treated like `mock`. */
export type HeaderNetwork = ReportNetwork | "unknown";

/** The report network for a round's Bitcoin network. */
export function reportNetwork(btc: string): ReportNetwork | null {
  return btc === "regtest" || btc === "signet" || btc === "testnet4" || btc === "bitcoin"
    ? btc
    : null;
}

/** One attempt's actual outcome, classed for the summary. */
export type ActualClass =
  /** On chain: an `ERR_*` code or a bare NEAR failure kind. Must be in the Attempt Log. */
  | "refused"
  /** On chain and accepted (the Withdrawal Request the watcher claws back). */
  | "accepted"
  /**
   * Allowed and harmless, not an Attempt Log attempt: the contract took it and nothing can move
   * (a 0-deposit `top_up_storage`, which emits only `storage_topped_up`).
   */
  | "allowed_harmless"
  /** A Bitcoin broadcast or a pre-inclusion NEAR refusal: never in the Attempt Log. */
  | "off_log"
  /** Not sent, with a reason (mock Vault kit, no Vault coin, coin already matured). */
  | "skipped"
  /** The outcome could not be read; never counted as a pass. */
  | "unreadable";

export type OffLogEvidence =
  /** A Bitcoin broadcast: the raw tx, its txid and the node's answer (empty when accepted). */
  | { kind: "bitcoin"; raw_hex: string; txid: string; rejection: string }
  /** A NEAR transaction refused before inclusion: the RPC error. */
  | { kind: "pre_inclusion"; reason: string; error: string };

export interface AttemptRecord {
  id: number;
  round: number;
  category: Category;
  method: string | null;
  /** The call's args (Bitcoin spends: null; their raw tx is in `off_log`). */
  args: unknown;
  /** sha256 of the canonical JSON args (sorted keys). */
  args_sha256: string | null;
  expected: readonly string[];
  /** The code or outcome that actually happened. */
  actual: string;
  actual_class: ActualClass;
  /** True when `actual` is one of `expected`. */
  expected_match: boolean;
  /** True when the contract or the Bitcoin node accepted what should have been refused. */
  unexpected: boolean;
  /** Window attempts only: did the call meet its own refusal or the Clawback? */
  window_result: "own_code" | "clawed_back" | null;
  tx_hash: string | null;
  explorer: string | null;
  /** For an accepted Withdrawal Request: its op id, for log matching. */
  op_id: string | null;
  /** For an accepted Policy Change: its change id, for log matching. */
  change_id: string | null;
  vault_id: string | null;
  /** The matched Attempt Log entry number, once found. */
  log_entry: number | null;
  /** Evidence for an attempt that can never be in the Attempt Log. */
  off_log: OffLogEvidence | null;
  /** Why an attempt was skipped or is unreadable. */
  note: string | null;
}

export interface RoundReport {
  round: number;
  /** The challenge's own round number from `/round`. */
  challenge_round: number;
  vault_id: string | null;
  vault_address: string | null;
  funding_txid: string | null;
  balance_before_sats: number | null;
  balance_after_sats: number | null;
  /** The accepted Withdrawal Request's NEAR tx hash, when one was accepted. */
  request_tx_hash: string | null;
  request_op_id: string | null;
  /** True once the Vault read `clawed_back`; false when the wait ran out; null when not awaited. */
  clawback_seen: boolean | null;
  clawback_op_id: string | null;
  clawback_txid: string | null;
  clawback_broadcast: boolean | null;
  /** The accepted Recovery Address redirect's change id, when one was accepted. */
  policy_change_id: string | null;
  /**
   * The redirect's end (see `RedirectOutcome`). Only `vetoed` proves the veto; `withdrawn` (another
   * holder of the published Owner Key took it back) neither proves nor fails it; anything else
   * fails the run. Null when no redirect was accepted.
   */
  policy_change_outcome: RedirectOutcome | null;
}

export interface AttackerAddress {
  address: string;
  /** Null when the balance could not be read (the run then fails). */
  final_balance_sats: number | null;
}

export interface ReportSummary {
  attacker_addresses: AttackerAddress[];
  sats_to_attackers: number;
  unreadable_balances: string[];
  on_log: string;
  on_log_matched: number;
  on_log_total: number;
  missing_hashes: string[];
  off_log: number;
  /** Allowed and harmless, not Attempt Log attempts (e.g. a 0-deposit storage top-up). */
  allowed_harmless: number;
  skipped: number[];
  unreadable: number[];
  unexpected: number[];
  /** Rounds whose Clawback was not seen within the wait. */
  clawback_missing: number[];
  /** Rounds whose accepted Recovery Address redirect neither was vetoed nor withdrawn. */
  veto_missing: number[];
  /** Accepted redirects the watcher vetoed; a passing run needs at least one. */
  redirects_vetoed: number;
  not_deployed: Category[];
  not_deployed_note: string | null;
  stopped_reason: string | null;
  passed: boolean;
}

export interface ReportHeader {
  tool_commit: string | null;
  /** True when the working tree had uncommitted changes. */
  tool_dirty: boolean;
  seed: number;
  network: HeaderNetwork;
  near_network: string;
  contract_id: string;
  code_hash: string | null;
  started_at: string;
  ended_at: string;
  near_tip_start: number | null;
  near_tip_end: number | null;
  btc_tip_start: number | null;
  btc_tip_end: number | null;
  challenge_rounds: number[];
  /** Every public key the run signed with (both if the key rotated mid-run). */
  public_keys: string[];
}

export interface AttackReport {
  header: ReportHeader;
  rounds: RoundReport[];
  attempts: AttemptRecord[];
  summary: ReportSummary;
}

export class ReportWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportWriteError";
  }
}

/** The repository root: `git rev-parse --show-toplevel`, else the dir with `pnpm-workspace.yaml`. */
export function repoRoot(from: string = process.cwd()): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: from,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    // not a git checkout: walk up
  }
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
}

/** Where `path` sits relative to the repository root, `/`-separated and case-folded. */
function repoRelative(path: string, root: string): string | null {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "" : null;
  return rel.split(sep).join("/").toLowerCase();
}

/**
 * Refuses a mock (or `unknown`) report anywhere under the repository's `evidence/`, and a regtest
 * report there unless under `evidence/regtest/`. A real-chain report may go anywhere.
 */
export function checkReportPath(path: string, network: HeaderNetwork, root = repoRoot()): void {
  const rel = repoRelative(path, root);
  if (rel === null) return; // outside the repository
  const inEvidence = rel === "evidence" || rel.startsWith("evidence/");
  const inRegtest = rel.startsWith("evidence/regtest/");
  if ((network === "mock" || network === "unknown") && inEvidence) {
    throw new ReportWriteError(`A ${network} report must not be written under evidence/: ${path}`);
  }
  if (network === "regtest" && inEvidence && !inRegtest) {
    throw new ReportWriteError(
      `A regtest report belongs under evidence/regtest/, not evidence/: ${path}`,
    );
  }
}

/** Writes `report` to `path`, running the evidence guard right before writing. */
export async function writeReport(
  path: string,
  report: AttackReport,
  root = repoRoot(),
): Promise<void> {
  checkReportPath(path, report.header.network, root);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/**
 * The default report path: `<repo>/evidence/challenge-attack-<network>-<ISO time>.json` for a
 * real chain, `<repo>/evidence/regtest/…` for regtest, and the system temp dir for a mock or
 * unknown-network report.
 */
export function defaultReportPath(
  network: HeaderNetwork,
  isoTime: string,
  root = repoRoot(),
): string {
  const file = `challenge-attack-${network}-${isoTime.replace(/[:.]/g, "-")}.json`;
  if (network === "mock" || network === "unknown") {
    return join(tmpdir(), "morrow-challenge-attack", file);
  }
  return join(root, network === "regtest" ? "evidence/regtest" : "evidence", file);
}
