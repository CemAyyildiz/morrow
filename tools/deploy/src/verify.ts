import { initProblems, type BtcNetwork, type InitArgs, type Target } from "./args.js";
import {
  NO_CONTRACT_HASH,
  describePermission,
  type AccessKeyEntry,
  type ChainReader,
} from "./rpc.js";

/** `get_config` as the contract returns it. */
export interface DeployedConfig {
  signer_account: string;
  allowed_networks: string[];
  creator_allowlist: string[];
  version: string;
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

const shown = (values: string[]) => (values.length === 0 ? "(open)" : values.join(","));

/**
 * Checks a deployed `get_config` with the same rules `deploy` applies to its arguments, against
 * the expected init when given, and its version against the contract source.
 */
export function checkConfig(
  value: unknown,
  target: Target,
  expected: InitArgs | undefined,
  version: string,
): { config: DeployedConfig | null; problems: string[] } {
  if (typeof value !== "object" || value === null) {
    return { config: null, problems: ["get_config returned no config"] };
  }
  const c = value as Record<string, unknown>;
  if (
    typeof c.signer_account !== "string" ||
    !strings(c.allowed_networks) ||
    !strings(c.creator_allowlist) ||
    typeof c.version !== "string"
  ) {
    return {
      config: null,
      problems: [
        "get_config is missing signer_account, allowed_networks, creator_allowlist or version",
      ],
    };
  }
  const config = c as unknown as DeployedConfig;
  const init: InitArgs = {
    signer_account: config.signer_account,
    allowed_networks: config.allowed_networks as BtcNetwork[],
    creator_allowlist: config.creator_allowlist,
  };
  const problems = initProblems(init, target.network).map(
    (p) => `get_config ${p.field}: ${p.message}`,
  );
  if (expected) {
    if (config.signer_account !== expected.signer_account) {
      problems.push(
        `get_config signer_account is ${config.signer_account}, expected ${expected.signer_account}`,
      );
    }
    if (!sameSet(config.allowed_networks, expected.allowed_networks)) {
      problems.push(
        `get_config allowed_networks is ${shown(config.allowed_networks)}, expected ${shown(expected.allowed_networks)}`,
      );
    }
    if (!sameSet(config.creator_allowlist, expected.creator_allowlist)) {
      problems.push(
        `get_config creator_allowlist is ${shown(config.creator_allowlist)}, expected ${shown(expected.creator_allowlist)}`,
      );
    }
  }
  if (config.version !== version) {
    problems.push(`get_config version is ${config.version}, the contract source says ${version}`);
  }
  return { config, problems };
}

export interface AccountReport {
  target: Target;
  blockHeight: number | null;
  codeHash: string | null;
  amount: bigint | null;
  keys: AccessKeyEntry[] | null;
  config: DeployedConfig | null;
  problems: string[];
}

export interface CheckOptions {
  requireLocked: boolean;
  expected: InitArgs | undefined;
  /** The contract crate version `get_config` must report. */
  version: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads one account at one final block: code hash, access keys, `get_config`. */
export async function checkAccount(
  reader: ChainReader,
  target: Target,
  localHash: string,
  options: CheckOptions,
): Promise<AccountReport> {
  const report: AccountReport = {
    target,
    blockHeight: null,
    codeHash: null,
    amount: null,
    keys: null,
    config: null,
    problems: [],
  };
  let snapshot;
  try {
    snapshot = await reader.snapshot(target.accountId);
  } catch (error) {
    report.problems.push(`RPC error: ${message(error)}`);
    return report;
  }
  report.blockHeight = snapshot.blockHeight;
  if (!snapshot.account) {
    report.problems.push("the account does not exist");
    return report;
  }
  report.codeHash = snapshot.account.codeHash;
  report.amount = snapshot.account.amount;
  if (report.codeHash === NO_CONTRACT_HASH) report.problems.push("no contract is deployed");
  else if (report.codeHash !== localHash) {
    report.problems.push(`code_hash ${report.codeHash} differs from the local build ${localHash}`);
  }
  report.keys = snapshot.keys;
  if (options.requireLocked && snapshot.keys.length > 0) {
    report.problems.push(`not locked: ${snapshot.keys.length} access key(s) remain`);
  }
  if (snapshot.configError !== null) {
    report.problems.push(`get_config failed: ${snapshot.configError}`);
  } else {
    const checked = checkConfig(snapshot.config, target, options.expected, options.version);
    report.config = checked.config;
    report.problems.push(...checked.problems);
  }
  return report;
}

export function configSummary(c: DeployedConfig): string {
  return `get_config: signer ${c.signer_account}, networks ${c.allowed_networks.join(",")}, allowlist ${shown(c.creator_allowlist)}, version ${c.version}`;
}

export function keyLines(keys: AccessKeyEntry[]): string[] {
  return keys.map((k) => `    ${k.publicKey} ${describePermission(k.permission)}`);
}

function describe(report: AccountReport, localHash: string): string[] {
  const { target } = report;
  const at = report.blockHeight === null ? "" : ` at final block ${report.blockHeight}`;
  const lines = [`${target.accountId} (${target.network})${at}`];
  if (report.codeHash !== null) {
    const same = report.codeHash === localHash ? "matches the local build" : "DIFFERS";
    lines.push(`  code_hash: ${report.codeHash} (${same})`);
  }
  if (report.keys?.length === 0) lines.push("  Locked: no access keys");
  else if (report.keys) {
    lines.push(`  Not locked: ${report.keys.length} access key(s)`, ...keyLines(report.keys));
  }
  if (report.config) lines.push(`  ${configSummary(report.config)}`);
  return lines;
}

export interface VerifyTarget extends Target {
  reader: ChainReader;
  expected?: InitArgs | undefined;
}

export interface VerifyRun {
  /** Default true: an account with any access key fails. */
  requireLocked?: boolean;
  version: string;
}

/**
 * Verifies every target against the local build and, with several, that they run the same code.
 * Returns the exit code: 0 only when every check passes.
 */
export async function verify(
  targets: VerifyTarget[],
  local: { path: string; hash: string },
  out: (line: string) => void,
  run: VerifyRun,
): Promise<number> {
  const requireLocked = run.requireLocked ?? true;
  out(`Local build: ${local.path}`);
  out(`  code_hash: ${local.hash}`);
  const reports: AccountReport[] = [];
  for (const target of targets) {
    const report = await checkAccount(target.reader, target, local.hash, {
      requireLocked,
      expected: target.expected,
      version: run.version,
    });
    reports.push(report);
    for (const line of describe(report, local.hash)) out(line);
  }
  const failures = reports.flatMap((r) =>
    r.problems.map((p) => `FAIL ${r.target.accountId}: ${p}`),
  );
  const hashes = new Set(reports.map((r) => r.codeHash).filter((h) => h !== null));
  if (hashes.size > 1) {
    const each = reports.map((r) => `${r.target.accountId}=${r.codeHash ?? "?"}`).join(", ");
    failures.push(`FAIL the accounts run different code: ${each}`);
  }
  if (failures.length > 0) {
    for (const line of failures) out(line);
    out(`Deployment NOT verified: ${failures.length} problem(s)`);
    return 1;
  }
  const state = reports.every((r) => r.keys?.length === 0) ? "locked" : "not locked yet";
  out(`Deployment verified: ${targets.length} account(s), code_hash ${local.hash}, ${state}`);
  return 0;
}
