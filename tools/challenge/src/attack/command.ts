/**
 * The `attack` command: parse flags, build the dry-run or live ports, run the scripted rounds,
 * write the report, print a short summary, and return `passed ? 0 : 1`.
 */
import { execFileSync } from "node:child_process";
import { loadAttackConfig } from "../config.js";
import { dryRunPorts } from "./dry-run.js";
import { liveAttackPorts } from "./live.js";
import {
  ReportWriteError,
  defaultReportPath,
  repoRoot,
  writeReport,
  type AttackReport,
} from "./report.js";
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

const VALUE_FLAGS = new Set(["--n", "--rounds", "--seed", "--out", "--round-wait", "--log-wait"]);

/** Parses the `attack` flags. Minutes for the waits; `--seed` defaults to a random 32-bit value. */
export function parseAttackFlags(
  argv: readonly string[],
  randomSeed: () => number = () => Math.floor(Math.random() * 0xffffffff),
): AttackFlags {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] as string;
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown flag ${flag}`);
    const value = argv[i + 1];
    // A following flag is never a value: `--out --dry-run` is a missing value.
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    i += 1;
  }
  const int = (flag: string, fallback: number, min = 1): number => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
      throw new Error(`${flag} must be a whole number ≥ ${min}`);
    }
    return n;
  };
  return {
    n: int("--n", 100),
    rounds: int("--rounds", 3),
    seed: values.has("--seed") ? int("--seed", 0, 0) : randomSeed(),
    dryRun,
    out: values.get("--out") ?? null,
    roundWaitMs: int("--round-wait", 60) * 60_000,
    logWaitMs: int("--log-wait", 10) * 60_000,
  };
}

/** The tool's git commit and whether the working tree had uncommitted changes. */
export function toolVersion(): { commit: string | null; dirty: boolean } {
  const git = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" };
  } catch {
    return { commit: null, dirty: false };
  }
}

export interface AttackCommandDeps {
  buildDryRun?: () => Promise<AttackPorts>;
  buildLive?: () => { ports: AttackPorts; nearNetwork: "testnet" | "mainnet" };
  write?: (path: string, report: AttackReport) => Promise<void>;
  root?: string;
  now?: () => Date;
  stdout?: (line: string) => void;
  version?: () => { commit: string | null; dirty: boolean };
}

/** Runs the command and returns the exit code (does not call `process.exit`). */
export async function runAttackCommand(
  argv: readonly string[],
  deps: AttackCommandDeps = {},
): Promise<number> {
  const flags = parseAttackFlags(argv);
  const root = deps.root ?? repoRoot();
  const write = deps.write ?? ((path, report) => writeReport(path, report, root));
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const version = (deps.version ?? toolVersion)();

  let ports: AttackPorts;
  let nearNetwork: "testnet" | "mainnet";
  if (flags.dryRun) {
    ports = deps.buildDryRun ? await deps.buildDryRun() : await dryRunPorts();
    nearNetwork = "testnet";
  } else if (deps.buildLive) {
    ({ ports, nearNetwork } = deps.buildLive());
  } else {
    const config = loadAttackConfig();
    ports = liveAttackPorts(config);
    nearNetwork = config.nearNetwork;
  }

  const params: AttackParams = {
    seed: flags.seed,
    n: flags.n,
    rounds: flags.rounds,
    nearNetwork,
    dryRun: flags.dryRun,
    toolCommit: version.commit,
    toolDirty: version.dirty,
    roundWaitMs: flags.roundWaitMs,
    logWaitMs: flags.logWaitMs,
  };

  const { report, exitCode } = await runAttack(ports, params);
  // The network is the first attacked round's, never assumed.
  if (report.header.near_network !== nearNetwork) {
    throw new ReportWriteError(
      `Refusing to write: MORROW_NEAR_NETWORK is ${nearNetwork} but the round is on ${report.header.near_network}`,
    );
  }
  const path = flags.out ?? defaultReportPath(report.header.network, now().toISOString(), root);
  await write(path, report); // the evidence guard runs inside, right before writing

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
        skipped: s.skipped.length,
        unreadable: s.unreadable.length,
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
