/**
 * The `attack` command: parse flags, build the dry-run or live ports, run the scripted rounds,
 * write the report, print a short summary, and exit with `passed ? 0 : 1`.
 */
import { execFileSync } from "node:child_process";
import { loadAttackConfig } from "../config.js";
import { dryRunPorts } from "./dry-run.js";
import { liveAttackPorts, reportNetwork } from "./live.js";
import { defaultReportPath, writeReport, type AttackReport, type ReportNetwork } from "./report.js";
import { runAttack, type AttackParams, type AttackPorts } from "./run.js";

export interface AttackFlags {
  n: number;
  rounds: number;
  seed: number;
  dryRun: boolean;
  out: string | null;
  roundWaitMs: number;
  logWaitMs: number;
}

const FLAGS = new Set([
  "--n",
  "--rounds",
  "--seed",
  "--dry-run",
  "--out",
  "--round-wait",
  "--log-wait",
]);

/** Parses the `attack` flags. Minutes for the waits; `--seed` defaults to a random 32-bit value. */
export function parseAttackFlags(argv: readonly string[]): AttackFlags {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (!FLAGS.has(flag)) throw new Error(`Unknown flag ${flag}`);
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    i += 1;
  }
  const int = (flag: string, fallback: number, min = 1): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min)
      throw new Error(`${flag} must be a whole number ≥ ${min}`);
    return n;
  };
  return {
    n: int("--n", 100),
    rounds: int("--rounds", 3),
    seed: int("--seed", Math.floor(Math.random() * 0xffffffff), 0),
    dryRun,
    out: values.get("--out") ?? null,
    roundWaitMs: int("--round-wait", 60) * 60_000,
    logWaitMs: int("--log-wait", 10) * 60_000,
  };
}

function toolCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export interface AttackCommandDeps {
  /** Overridable for tests. */
  buildDryRun?: () => Promise<AttackPorts>;
  buildLive?: () => {
    ports: AttackPorts;
    network: ReportNetwork;
    nearNetwork: "testnet" | "mainnet";
  };
  write?: (path: string, report: AttackReport) => Promise<void>;
  now?: () => Date;
  stdout?: (line: string) => void;
}

/** Runs the command and returns the exit code (does not call `process.exit`). */
export async function runAttackCommand(
  argv: readonly string[],
  deps: AttackCommandDeps = {},
): Promise<number> {
  const flags = parseAttackFlags(argv);
  const write = deps.write ?? writeReport;
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());

  let ports: AttackPorts;
  let network: ReportNetwork;
  let nearNetwork: "testnet" | "mainnet";
  if (flags.dryRun) {
    ports = deps.buildDryRun ? await deps.buildDryRun() : await dryRunPorts();
    network = "mock";
    nearNetwork = "testnet";
  } else if (deps.buildLive) {
    const built = deps.buildLive();
    ports = built.ports;
    network = built.network;
    nearNetwork = built.nearNetwork;
  } else {
    const config = loadAttackConfig();
    ports = liveAttackPorts(config);
    nearNetwork = config.nearNetwork;
    // The report network comes from the first round's Bitcoin network; signet until one is seen.
    const first = await ports.rounds.current().catch(() => null);
    network = reportNetwork(first?.btc_network ?? "signet");
  }

  const params: AttackParams = {
    seed: flags.seed,
    n: flags.n,
    rounds: flags.rounds,
    network,
    nearNetwork,
    dryRun: flags.dryRun,
    toolCommit: toolCommit(),
    roundWaitMs: flags.roundWaitMs,
    logWaitMs: flags.logWaitMs,
  };

  const { report, exitCode } = await runAttack(ports, params);
  const path = flags.out ?? defaultReportPath(network, now().toISOString());
  await write(path, report);

  const s = report.summary;
  stdout(
    JSON.stringify(
      {
        network: report.header.network,
        seed: report.header.seed,
        attempts: report.attempts.length,
        rounds: report.rounds.length,
        on_log: s.on_log,
        off_log: s.off_log,
        allowed_harmless: s.allowed_harmless,
        sats_to_attackers: s.sats_to_attackers,
        not_deployed: s.not_deployed,
        stopped_reason: s.stopped_reason,
        passed: s.passed,
        report: path,
      },
      null,
      2,
    ),
  );
  return exitCode;
}
