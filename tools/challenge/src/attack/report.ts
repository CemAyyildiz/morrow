/**
 * The attack report: a JSON document a judge can re-check against the chain. The writer refuses
 * to put a mock or regtest report under `evidence/` (that path is for real-chain runs only;
 * regtest is allowed only under `evidence/regtest/` and labelled).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Category } from "./plan.js";

/** The network a report was produced against. `mock` is the dry run. */
export type ReportNetwork = "mock" | "regtest" | "signet" | "testnet4" | "bitcoin";

/** One attempt's actual outcome, classed for the summary. */
export type ActualClass =
  /** On chain and in the Attempt Log's reach: an `ERR_*` code or a bare NEAR failure kind. */
  | "refused"
  /** Accepted and clawed back (a Withdrawal Request). */
  | "accepted"
  /** Accepted, emits no event, nothing can move (e.g. a 0-deposit top-up). */
  | "allowed_harmless"
  /** A Bitcoin broadcast or a pre-inclusion NEAR refusal: never in the Attempt Log. */
  | "off_log"
  /** The outcome could not be read; never counted as a pass. */
  | "unreadable";

export interface AttemptRecord {
  id: number;
  round: number;
  category: Category;
  method: string | null;
  /** sha256 of the canonical JSON args (Bitcoin spends have no args). */
  args_sha256: string | null;
  expected: readonly string[];
  /** The code or class that actually happened. */
  actual: string;
  actual_class: ActualClass;
  /** True when `actual` is one of `expected` (or a window attempt met `ERR_CLAWED_BACK`). */
  expected_match: boolean;
  tx_hash: string | null;
  explorer: string | null;
  /** For an accepted Withdrawal Request: its op id and Vault id, for log matching. */
  op_id: string | null;
  vault_id: string | null;
  /** The matched Attempt Log entry number, once found. */
  log_entry: number | null;
  /** Evidence for an attempt that can never be in the Attempt Log. */
  off_log: OffLogEvidence | null;
}

export type OffLogEvidence =
  /** A Bitcoin broadcast: the raw tx, its txid and the node's rejection text. */
  | { kind: "bitcoin"; raw_hex: string; txid: string; rejection: string }
  /** A NEAR transaction refused before inclusion: the RPC error. */
  | { kind: "pre_inclusion"; reason: string; error: string };

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
  clawback_op_id: string | null;
  clawback_txid: string | null;
}

export interface AttackerAddress {
  address: string;
  final_balance_sats: number;
}

export interface ReportSummary {
  attacker_addresses: AttackerAddress[];
  sats_to_attackers: number;
  on_log: string;
  on_log_matched: number;
  on_log_total: number;
  missing_hashes: string[];
  off_log: number;
  allowed_harmless: number;
  not_deployed: Category[];
  not_deployed_note: string | null;
  stopped_reason: string | null;
  passed: boolean;
}

export interface ReportHeader {
  tool_commit: string | null;
  seed: number;
  network: ReportNetwork;
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
  /** Every public key the run signed with (both halves if the key rotated mid-run). */
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

const EVIDENCE = `${sep}evidence${sep}`;
const EVIDENCE_REGTEST = `${sep}evidence${sep}regtest${sep}`;

/**
 * Refuses a mock or regtest report into `evidence/` (regtest may go under `evidence/regtest/`).
 * A real-chain report (signet/testnet4/bitcoin) may go anywhere.
 */
export function checkReportPath(path: string, network: ReportNetwork): void {
  const full = resolve(path);
  const inEvidence = full.includes(EVIDENCE) && !full.includes(EVIDENCE_REGTEST);
  const inRegtestEvidence = full.includes(EVIDENCE_REGTEST);
  if (network === "mock" && (inEvidence || inRegtestEvidence)) {
    throw new ReportWriteError(
      `A mock (dry-run) report must not be written under evidence/: ${path}`,
    );
  }
  if (network === "regtest" && inEvidence) {
    throw new ReportWriteError(
      `A regtest report belongs under evidence/regtest/, not evidence/: ${path}`,
    );
  }
}

/** Writes `report` to `path`, after the evidence-path guard. Creates parent directories. */
export async function writeReport(path: string, report: AttackReport): Promise<void> {
  checkReportPath(path, report.header.network);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** The default report path: `evidence/challenge-attack-<network>-<ISO time>.json`. */
export function defaultReportPath(network: ReportNetwork, isoTime: string): string {
  const stamp = isoTime.replace(/[:.]/g, "-");
  const dir = network === "mock" ? "." : network === "regtest" ? "evidence/regtest" : "evidence";
  return `${dir}/challenge-attack-${network}-${stamp}.json`;
}
